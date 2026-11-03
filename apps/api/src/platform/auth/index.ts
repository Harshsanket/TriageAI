/**
 * Auth wiring for the API host: public endpoints plus the global guard that
 * authenticates bearer tokens and enforces the RBAC matrix.
 */
import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AppError } from '../errors.js';
import { isAllowed, ruleFor } from './rbac.js';
import type { AuthService } from './service.js';
import { verifyAccessToken, type Role } from './tokens.js';

export interface Principal {
  userId: string;
  email: string;
  role: Role | 'anonymous';
  sessionId: string | null;
  authenticated: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AuthGuardOptions {
  mode: 'disabled' | 'required';
  jwtSecret: string;
  /** Static bearer token a Prometheus scraper may present for GET /metrics. */
  metricsToken?: string;
  /** First-run setup: while pending, setup routes take the one-time token instead. */
  setup?: { isPending(): boolean; verify(header: string | undefined): boolean };
  /** Re-check the session/role so a logged-out or demoted token stops working. */
  isAccessCurrent?: (claims: Awaited<ReturnType<typeof verifyAccessToken>>) => Promise<boolean>;
}

const SETUP_OPERATOR: Principal = {
  userId: 'setup-operator',
  email: 'setup@triageai.dev',
  role: 'admin',
  sessionId: null,
  authenticated: true,
};

const ANONYMOUS: Principal = {
  userId: 'anonymous',
  email: '',
  role: 'anonymous',
  sessionId: null,
  authenticated: false,
};

const METRICS_SCRAPER: Principal = {
  userId: 'metrics-scraper',
  email: 'metrics@triageai.dev',
  role: 'agent',
  sessionId: null,
  authenticated: false,
};

function tokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const LOCAL_DEVELOPER: Principal = {
  userId: 'local-developer',
  email: 'local@triageai.dev',
  role: 'admin',
  sessionId: null,
  authenticated: true,
};

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

export function createAuthGuard(options: AuthGuardOptions) {
  return async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?')[0] ?? request.url;
    const rule = ruleFor(request.method, path);

    if (
      options.setup?.isPending() &&
      path.startsWith('/api/v1/setup/') &&
      path !== '/api/v1/setup/status'
    ) {
      if (!options.setup.verify(request.headers.authorization)) {
        throw new AppError(
          'setup.TOKEN_REQUIRED',
          'paste the setup token printed in the API log',
          undefined,
          401,
        );
      }
      request.principal = SETUP_OPERATOR;
      return;
    }

    if (options.mode === 'disabled') {
      request.principal = LOCAL_DEVELOPER;
      return;
    }

    // Key-authenticated surfaces validate their own API key: the guard must
    // not try to verify it as a session JWT (R2).
    if (rule.roles === 'key') {
      request.principal = ANONYMOUS;
      return;
    }

    const token = bearerToken(request);
    if (!token) {
      if (rule.roles === 'public') {
        request.principal = ANONYMOUS;
        return;
      }
      reply.header('www-authenticate', 'Bearer');
      throw new AppError('auth.UNAUTHENTICATED', 'missing bearer token', undefined, 401);
    }

    if (
      options.metricsToken &&
      request.method === 'GET' &&
      path === '/metrics' &&
      tokenEquals(token, options.metricsToken)
    ) {
      request.principal = METRICS_SCRAPER;
      return;
    }

    const claims = await verifyAccessToken(token, { secret: options.jwtSecret });
    if (options.isAccessCurrent && !(await options.isAccessCurrent(claims))) {
      throw new AppError(
        'auth.UNAUTHENTICATED',
        'the session was revoked or the account role changed; sign in again',
        undefined,
        401,
      );
    }
    request.principal = {
      userId: claims.sub,
      email: claims.email,
      role: claims.role,
      sessionId: claims.sid,
      authenticated: true,
    };

    if (rule.roles !== 'public' && !isAllowed(claims.role, request.method, path)) {
      throw new AppError(
        'auth.FORBIDDEN',
        `role ${claims.role} may not ${request.method} ${path}`,
        { requiredRoles: rule.roles },
        403,
      );
    }
  };
}

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const passwordSchema = z
  .string()
  .min(10, 'password must be at least 10 characters')
  .max(200, 'password must be at most 200 characters');

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

const roleSchema = z.enum(['customer', 'agent', 'admin']);

export function loginRateLimitKey(request: FastifyRequest): string {
  const email = (request.body as { email?: unknown } | null)?.email;
  return `${request.ip}:${String(email ?? '')}`;
}

export interface AuthRouteOptions {
  mode: 'disabled' | 'required';
}

const REFRESH_COOKIE = 'triageai_refresh';

function refreshCookie(token: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${REFRESH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearRefreshCookie(): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${REFRESH_COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/v1/auth; Max-Age=0${secure}`;
}

function cookieToken(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === REFRESH_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  service: AuthService,
  options: AuthRouteOptions,
): void {
  // Key the login limiter by client IP *and* email so one attacker cannot lock
  // every user out of login (R3).
  const loginRateLimit = {
    max: options.mode === 'required' ? 10 : 1000,
    timeWindow: '1 minute',
    keyGenerator: loginRateLimitKey,
  };

  app.post(
    '/api/v1/auth/register',
    { config: { rateLimit: loginRateLimit } },
    async (request, reply) => {
      const body = registerSchema.parse(request.body);
      const session = await service.register(body);
      reply.header('set-cookie', refreshCookie(session.refreshToken, 30 * 24 * 60 * 60));
      return reply.status(201).send(session);
    },
  );

  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: loginRateLimit } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body);
      const session = await service.login(body.email, body.password);
      reply.header('set-cookie', refreshCookie(session.refreshToken, 30 * 24 * 60 * 60));
      return session;
    },
  );

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const parsed = z
      .object({ refreshToken: z.string().min(20).max(500).optional() })
      .parse(request.body ?? {});
    const token = parsed.refreshToken ?? cookieToken(request);
    if (!token) {
      throw new AppError('auth.UNAUTHENTICATED', 'missing refresh token', undefined, 401);
    }
    const session = await service.refresh(token);
    reply.header('set-cookie', refreshCookie(session.refreshToken, 30 * 24 * 60 * 60));
    return session;
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const body = z
      .object({ refreshToken: z.string().min(20).max(500).optional() })
      .parse(request.body ?? {});
    const token = body.refreshToken ?? cookieToken(request);
    if (token) await service.logout(token);
    reply.header('set-cookie', clearRefreshCookie());
    return { loggedOut: true };
  });

  app.get('/api/v1/auth/me', async (request) => {
    const principal = request.principal;
    if (!principal) throw new AppError('auth.UNAUTHENTICATED', 'missing session', undefined, 401);
    if (!principal.authenticated) {
      return {
        user: {
          id: principal.userId,
          email: principal.email,
          name: 'Local developer',
          role: principal.role,
          createdAt: new Date(0).toISOString(),
        },
        mode: options.mode,
      };
    }
    const user = await service.getById(principal.userId);
    if (!user) throw new AppError('auth.UNAUTHENTICATED', 'user no longer exists', undefined, 401);
    return { user, mode: options.mode };
  });

  app.get('/api/v1/auth/users', async () => ({ users: await service.listUsers() }));

  app.post('/api/v1/auth/users', async (request, reply) => {
    const body = registerSchema.extend({ role: roleSchema.default('agent') }).parse(request.body);
    const actor = request.principal?.email ?? 'system';
    const user = await service.createUser({ ...body, actor });
    return reply.status(201).send({ user });
  });

  app.patch('/api/v1/auth/users/:id/role', async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({ role: roleSchema }).parse(request.body);
    const principal = request.principal;
    if (!principal) throw new AppError('auth.UNAUTHENTICATED', 'missing session', undefined, 401);
    const user = await service.updateRole(id, body.role, principal.email, principal.userId);
    return { user };
  });
}
