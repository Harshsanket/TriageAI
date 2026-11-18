import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { AuthService } from '../src/platform/auth/service.js';
import { config } from '../src/platform/config.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

type App = FastifyInstance & { kernel?: Kernel };

describeIfDb('legal holds and forget me API (phase 18.8)', () => {
  let app: App;
  let dir: string;
  const suffix = ulid().toLowerCase();
  const users = {
    admin: { email: `hold-admin-${suffix}@test.dev`, password: 'admin-password-123' },
    agent: { email: `hold-agent-${suffix}@test.dev`, password: 'agent-password-123' },
    customer: { email: `hold-customer-${suffix}@test.dev`, password: 'customer-password-123' },
    subject: { email: `hold-subject-${suffix}@test.dev`, password: 'subject-password-123' },
  };
  const tokens: Record<keyof typeof users, string> = {
    admin: '',
    agent: '',
    customer: '',
    subject: '',
  };
  let subjectId = '';
  let holdId = '';

  async function call(
    who: keyof typeof users,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokens[who]}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'triageai-holds-'));
    const configPath = join(dir, 'triage.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        profile: 'core',
        modules: { echo: { enabled: true }, chat: { enabled: false } },
        capabilities: {},
      }),
    );
    app = (await buildApp({
      quiet: true,
      configPath,
      authMode: 'required',
      rateLimit: { max: 0 },
    })) as App;
    const service = new AuthService(app.kernel!.database, {
      accessTtlSeconds: config.authAccessTtlSeconds,
      refreshTtlSeconds: config.authRefreshTtlSeconds,
      jwtSecret: config.authJwtSecret,
    });
    for (const [name, user] of Object.entries(users) as Array<
      [keyof typeof users, typeof users.admin]
    >) {
      const role = name === 'admin' ? 'admin' : name === 'agent' ? 'agent' : ('customer' as const);
      const created = await service.createUser({ ...user, name, role, actor: 'test' });
      if (name === 'subject') subjectId = created.id;
      tokens[name] = (await service.login(user.email, user.password)).accessToken;
    }
    const db = app.kernel!.database;
    await db.query(`INSERT INTO user_preferences (user_id, preferences) VALUES ($1, '{}')`, [
      subjectId,
    ]);
    await db.query(
      `INSERT INTO user_skills (id, owner_id, name, description, content)
       VALUES ($1, $2, 'hold-skill', 'x', 'x')`,
      [ulid(), users.subject.email],
    );
    await db.query(
      `INSERT INTO candidate_examples (id, source, input, gold, provenance, status, actor)
       VALUES ($1, 'test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'proposed', $2)`,
      [ulid(), users.subject.email],
    );
  });

  afterAll(async () => {
    const db = app.kernel?.database;
    if (db) {
      await db.query(`DELETE FROM legal_holds WHERE id = $1`, [holdId]);
      await db.query(`DELETE FROM activity_events WHERE subject LIKE $1`, [
        `hold-%-${suffix}@test.dev`,
      ]);
      await db.query(`DELETE FROM activity_events WHERE actor LIKE $1`, [
        `hold-%-${suffix}@test.dev`,
      ]);
      await db.query(`DELETE FROM user_skills WHERE owner_id LIKE $1`, [`hold-%${suffix}%`]);
      await db.query(`DELETE FROM candidate_examples WHERE actor LIKE $1`, [
        `hold-%-${suffix}@test.dev`,
      ]);
      await db.query(`DELETE FROM users WHERE email LIKE $1`, [`hold-%-${suffix}@test.dev`]);
    }
    await app?.close();
  });

  it('creates, lists and releases an admin legal hold with audit rows', async () => {
    const created = await call('admin', 'POST', '/api/v1/system/legal-holds', {
      classId: 'decision_records',
      reason: 'litigation hold',
    });
    expect(created.statusCode).toBe(200);
    const hold = created.json() as { id: string; classId: string; active: boolean };
    expect(hold).toMatchObject({ classId: 'decision_records', active: true });
    holdId = hold.id;

    const listed = await call('admin', 'GET', '/api/v1/system/legal-holds');
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { holds: Array<{ id: string }> }).holds.map((row) => row.id),
    ).toContain(holdId);

    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'legal_hold.created' AND subject = $1`,
      ['decision_records'],
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    const released = await call('admin', 'DELETE', `/api/v1/system/legal-holds/${holdId}`);
    expect(released.statusCode).toBe(200);
    const releasedAudit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'legal_hold.released' AND subject = $1`,
      ['decision_records'],
    );
    expect(releasedAudit.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects holds for classes that do not support them', async () => {
    const res = await call('admin', 'POST', '/api/v1/system/legal-holds', {
      classId: 'legal_holds',
      reason: 'nope',
    });
    expect(res.statusCode).toBe(400);
  });

  it('is admin-only', async () => {
    expect(
      (
        await call('agent', 'POST', '/api/v1/system/legal-holds', {
          classId: 'decision_records',
          reason: 'nope',
        })
      ).statusCode,
    ).toBe(403);
    expect((await call('customer', 'GET', '/api/v1/system/legal-holds')).statusCode).toBe(403);
  });

  it('deletes a subject from kernel classes and reports module-owned classes', async () => {
    const res = await call('admin', 'POST', '/api/v1/system/forget-me', {
      subject: users.subject.email,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      deleted: Record<string, number>;
      skipped: Array<{ classId: string; reason: string }>;
    };
    expect(body.deleted.users).toBe(1);
    expect(body.deleted.user_preferences).toBe(1);
    expect(body.deleted.user_skills).toBe(1);
    expect(body.deleted.candidate_examples).toBe(1);
    expect(body.skipped).toContainEqual({
      classId: 'support_tickets',
      reason: 'module-owned:support',
    });
    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'privacy.forget_me' AND subject = $1`,
      [users.subject.email],
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(
      await app.kernel!.database.query(`SELECT 1 FROM users WHERE id = $1`, [subjectId]),
    ).toHaveLength(0);
  });

  it('keeps forget-me admin-only', async () => {
    const res = await call('agent', 'POST', '/api/v1/system/forget-me', {
      subject: users.agent.email,
    });
    expect(res.statusCode).toBe(403);
  });
});
