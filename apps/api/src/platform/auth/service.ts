/**
 * Host-owned identity + session service (FR-11.1). The kernel deliberately does
 * not know about users; auth is part of the `_system` host surface
 * (ARCHITECTURE §9, ADR-0020).
 */
import { ulid } from 'ulid';

import type { Database, TxDatabase } from '@triageai/kernel';

import { writeAudit } from '../../services/audit.js';
import { AppError } from '../errors.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  createRefreshToken,
  hashRefreshToken,
  signAccessToken,
  type AccessClaims,
  type Role,
} from './tokens.js';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface AuthServiceOptions {
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  jwtSecret: string;
}

interface UserRow {
  [key: string]: unknown;
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: Role;
  created_at: Date | string;
}

interface SessionRow {
  [key: string]: unknown;
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  replaced_by: string | null;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const toUser = (row: UserRow): AuthUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  createdAt: new Date(row.created_at).toISOString(),
});

// Verified against when the email is unknown so a miss costs the same argon2
// work as a wrong password (no user enumeration by response time).
let dummyHash: Promise<string> | undefined;
const timingDummyHash = (): Promise<string> =>
  (dummyHash ??= hashPassword('timing-equaliser-not-a-real-password'));

const isoIn = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();

export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly options: AuthServiceOptions,
  ) {}

  async userCount(): Promise<number> {
    const rows = (await this.database.query(`SELECT count(*)::int AS count FROM users`)) as Array<{
      count: number;
    }>;
    return rows[0]?.count ?? 0;
  }

  /**
   * First-user bootstrap is the only unauthenticated account creation path.
   * Once any user exists, registration closes (admins create the rest).
   */
  async register(input: { email: string; password: string; name: string }): Promise<AuthSession> {
    const email = normalizeEmail(input.email);
    const user = await this.database.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('auth:bootstrap'))`);
      const rows = (await tx.query(`SELECT count(*)::int AS count FROM users`)) as Array<{
        count: number;
      }>;
      if ((rows[0]?.count ?? 0) > 0) {
        throw new AppError(
          'auth.REGISTRATION_CLOSED',
          'an account already exists; ask an admin to create users',
          undefined,
          403,
        );
      }
      const id = ulid();
      const inserted = (await tx.query<UserRow>(
        `INSERT INTO users (id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'admin')
         RETURNING id, email, password_hash, name, role, created_at`,
        [id, email, await hashPassword(input.password), input.name.trim()],
      )) as unknown as UserRow[];
      return inserted[0] as UserRow;
    });
    await writeAudit(this.database, {
      actor: user.email,
      action: 'auth.user_registered',
      subject: user.id,
      payload: { role: user.role, bootstrap: true },
    });
    return this.issueSession(user);
  }

  async login(emailInput: string, password: string): Promise<AuthSession> {
    const email = normalizeEmail(emailInput);
    const rows = (await this.database.query<UserRow>(
      `SELECT id, email, password_hash, name, role, created_at
       FROM users WHERE email = $1`,
      [email],
    )) as unknown as UserRow[];
    const user = rows[0];
    const ok = user
      ? await verifyPassword(user.password_hash, password)
      : (await verifyPassword(await timingDummyHash(), password)) && false;
    if (!user || !ok) {
      await writeAudit(this.database, {
        actor: email,
        action: 'auth.login_failed',
        subject: user?.id ?? null,
        payload: {},
      });
      throw new AppError('auth.INVALID_CREDENTIALS', 'invalid email or password', undefined, 401);
    }
    await writeAudit(this.database, {
      actor: user.email,
      action: 'auth.login',
      subject: user.id,
      payload: { role: user.role },
    });
    return this.issueSession(user);
  }

  /** Rotate refresh tokens; presenting an already-used token revokes its family. */
  async refresh(rawToken: string): Promise<AuthSession> {
    const tokenHash = hashRefreshToken(rawToken);
    const rows = (await this.database.query<SessionRow>(
      `SELECT id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by
       FROM auth_sessions WHERE token_hash = $1`,
      [tokenHash],
    )) as unknown as SessionRow[];
    const session = rows[0];
    if (!session) {
      throw new AppError('auth.INVALID_REFRESH', 'invalid refresh token', undefined, 401);
    }
    if (session.revoked_at) {
      await this.revokeFamily(session.family_id, 'reuse_detected');
      await writeAudit(this.database, {
        actor: null,
        action: 'auth.refresh_reuse',
        subject: session.user_id,
        payload: { familyId: session.family_id, severity: 'high' },
      });
      throw new AppError(
        'auth.REFRESH_REPLAY',
        'refresh token was already used; the session family has been revoked',
        undefined,
        401,
      );
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw new AppError('auth.REFRESH_EXPIRED', 'refresh token expired', undefined, 401);
    }
    const userRows = (await this.database.query<UserRow>(
      `SELECT id, email, password_hash, name, role, created_at
       FROM users WHERE id = $1`,
      [session.user_id],
    )) as unknown as UserRow[];
    const user = userRows[0];
    if (!user) throw new AppError('auth.INVALID_REFRESH', 'user no longer exists', undefined, 401);

    return this.database.transaction(async (tx) => {
      const nextId = ulid();
      const revoked = (await tx.query(
        `UPDATE auth_sessions SET revoked_at = now(), replaced_by = $2
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [session.id, nextId],
      )) as unknown as Array<{ id: string }>;
      if (!revoked[0]) {
        throw new AppError('auth.REFRESH_REPLAY', 'refresh token was already used', undefined, 401);
      }
      return this.issueSession(user, session.family_id, tx);
    });
  }

  async logout(rawToken: string): Promise<void> {
    const rows = (await this.database.query<SessionRow>(
      `SELECT id, user_id, token_hash, family_id, expires_at, revoked_at, replaced_by
       FROM auth_sessions WHERE token_hash = $1`,
      [hashRefreshToken(rawToken)],
    )) as unknown as SessionRow[];
    const session = rows[0];
    if (!session) return;
    await this.revokeFamily(session.family_id, 'logout');
    await writeAudit(this.database, {
      actor: null,
      action: 'auth.logout',
      subject: session.user_id,
      payload: { familyId: session.family_id },
    });
  }

  async getById(id: string): Promise<AuthUser | null> {
    const rows = (await this.database.query<UserRow>(
      `SELECT id, email, password_hash, name, role, created_at FROM users WHERE id = $1`,
      [id],
    )) as unknown as UserRow[];
    return rows[0] ? toUser(rows[0]) : null;
  }

  async listUsers(): Promise<AuthUser[]> {
    const rows = (await this.database.query<UserRow>(
      `SELECT id, email, password_hash, name, role, created_at
       FROM users ORDER BY created_at ASC LIMIT 500`,
    )) as unknown as UserRow[];
    return rows.map(toUser);
  }

  async createUser(input: {
    email: string;
    password: string;
    name: string;
    role: Role;
    actor: string;
  }): Promise<AuthUser> {
    const email = normalizeEmail(input.email);
    const id = ulid();
    try {
      const rows = (await this.database.query<UserRow>(
        `INSERT INTO users (id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, password_hash, name, role, created_at`,
        [id, email, await hashPassword(input.password), input.name.trim(), input.role],
      )) as unknown as UserRow[];
      const user = toUser(rows[0] as UserRow);
      await writeAudit(this.database, {
        actor: input.actor,
        action: 'auth.user_created',
        subject: user.id,
        payload: { role: user.role, email: user.email },
      });
      return user;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(
          'auth.EMAIL_TAKEN',
          'a user with that email already exists',
          undefined,
          409,
        );
      }
      throw err;
    }
  }

  async updateRole(id: string, role: Role, actor: string, actorId: string): Promise<AuthUser> {
    if (id === actorId && role !== 'admin') {
      throw new AppError(
        'auth.SELF_DEMOTION',
        'refusing to remove the admin role from the current session',
        undefined,
        409,
      );
    }
    const rows = (await this.database.query<UserRow>(
      `UPDATE users SET role = $2, updated_at = now() WHERE id = $1
       RETURNING id, email, password_hash, name, role, created_at`,
      [id, role],
    )) as unknown as UserRow[];
    const row = rows[0];
    if (!row) throw new AppError('NOT_FOUND', `user ${id} not found`);
    await writeAudit(this.database, {
      actor,
      action: 'auth.role_changed',
      subject: id,
      payload: { role },
    });
    return toUser(row);
  }

  private async issueSession(
    user: UserRow,
    familyId?: string,
    database: TxDatabase = this.database,
  ): Promise<AuthSession> {
    const id = ulid();
    const refreshToken = createRefreshToken();
    const expiresAt = isoIn(this.options.refreshTtlSeconds);
    await database.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, family_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, user.id, hashRefreshToken(refreshToken), familyId ?? id, expiresAt],
    );
    const claims: AccessClaims = {
      sub: user.id,
      email: user.email,
      role: user.role,
      sid: id,
    };
    const accessToken = await signAccessToken(claims, {
      secret: this.options.jwtSecret,
      ttlSeconds: this.options.accessTtlSeconds,
    });
    return {
      user: toUser(user),
      accessToken,
      refreshToken,
      accessExpiresAt: isoIn(this.options.accessTtlSeconds),
      refreshExpiresAt: expiresAt,
    };
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.database.query(
      `UPDATE auth_sessions SET revoked_at = now()
       WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
    );
    await writeAudit(this.database, {
      actor: null,
      action: 'auth.family_revoked',
      subject: familyId,
      payload: { reason },
    });
  }
}
