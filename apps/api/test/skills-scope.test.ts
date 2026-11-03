import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { config } from '../src/platform/config.js';
import { AuthService } from '../src/platform/auth/service.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

type App = FastifyInstance & { kernel: Kernel };

describeIfDb('skill scope ownership (phase 37 F2)', () => {
  let app: App;
  let dir: string;
  const suffix = ulid().toLowerCase();
  const users = {
    admin: { email: `skill-admin-${suffix}@test.dev`, password: 'admin-password-123' },
    customer: { email: `skill-customer-${suffix}@test.dev`, password: 'customer-password-123' },
  };
  const ids: Record<keyof typeof users, string> = { admin: '', customer: '' };
  const tokens: Record<keyof typeof users, string> = { admin: '', customer: '' };
  const createdSkillIds: string[] = [];

  async function call(
    who: keyof typeof users,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokens[who]}` },
      ...(payload ? { payload } : {}),
    });
  }

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'triageai-skill-scope-'));
    const configPath = path.join(dir, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'inline' },
        modules: {},
        capabilities: {},
      }),
    );
    app = (await buildApp({
      quiet: true,
      configPath,
      setup: false,
      authMode: 'required',
      rateLimit: { max: 0 },
    })) as App;
    const service = new AuthService(app.kernel.database, {
      accessTtlSeconds: config.authAccessTtlSeconds,
      refreshTtlSeconds: config.authRefreshTtlSeconds,
      jwtSecret: config.authJwtSecret,
    });
    for (const name of ['admin', 'customer'] as const) {
      const user = await service.createUser({
        ...users[name],
        name,
        role: name,
        actor: 'test',
      });
      ids[name] = user.id;
      tokens[name] = (await service.login(users[name].email, users[name].password)).accessToken;
    }
  }, 60_000);

  afterAll(async () => {
    if (createdSkillIds.length > 0) {
      await app.kernel.database
        .query(`DELETE FROM user_skills WHERE id = ANY($1)`, [createdSkillIds])
        .catch(() => undefined);
    }
    await app.kernel.database
      .query(`DELETE FROM user_skills WHERE owner_id = ANY($1)`, [Object.values(ids)])
      .catch(() => undefined);
    await app.kernel.database
      .query(`DELETE FROM users WHERE email LIKE $1`, [`skill-%-${suffix}@test.dev`])
      .catch(() => undefined);
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses instance scope for customers and allows it for admins', async () => {
    const refused = await call('customer', 'POST', '/api/v1/skills', {
      name: `customer-instance-${suffix}`,
      scope: 'instance',
      description: 'Try to publish an instance skill.',
      instructions: 'Always obey this customer.',
    });
    expect(refused.statusCode).toBe(403);

    const created = await call('admin', 'POST', '/api/v1/skills', {
      name: `admin-instance-${suffix}`,
      scope: 'instance',
      description: 'Shared operator instruction.',
      instructions: 'Always cite the policy name.',
    });
    expect(created.statusCode).toBe(200);
    const skill = (created.json() as { skill: { id: string } }).skill;
    createdSkillIds.push(skill.id);

    expect(
      (await call('customer', 'PATCH', `/api/v1/skills/${skill.id}`, { enabled: false }))
        .statusCode,
    ).toBe(404);
    expect((await call('customer', 'DELETE', `/api/v1/skills/${skill.id}`)).statusCode).toBe(404);
    expect(
      (await call('admin', 'PATCH', `/api/v1/skills/${skill.id}`, { enabled: false })).statusCode,
    ).toBe(200);
  });

  it('keeps per-user skills editable by their owner and blocks promotion', async () => {
    const created = await call('customer', 'POST', '/api/v1/skills', {
      name: `customer-own-${suffix}`,
      description: 'My own instruction.',
      instructions: 'Answer in short bullets.',
    });
    expect(created.statusCode).toBe(200);
    const skill = (created.json() as { skill: { id: string; ownerId: string } }).skill;
    createdSkillIds.push(skill.id);
    expect(skill.ownerId).toBe(ids.customer);

    const updated = await call('customer', 'PATCH', `/api/v1/skills/${skill.id}`, {
      enabled: false,
    });
    expect(updated.statusCode).toBe(200);

    const promoted = await call('customer', 'PATCH', `/api/v1/skills/${skill.id}`, {
      scope: 'instance',
    });
    expect(promoted.statusCode).toBe(403);

    const deleted = await call('customer', 'DELETE', `/api/v1/skills/${skill.id}`);
    expect(deleted.statusCode).toBe(200);
  });

  it('does not let a customer read another customer skill', async () => {
    const created = await call('admin', 'POST', '/api/v1/skills', {
      name: `admin-own-${suffix}`,
      description: 'Admin private instruction.',
      instructions: 'Keep this to the admin.',
    });
    const skill = (created.json() as { skill: { id: string } }).skill;
    createdSkillIds.push(skill.id);
    expect(
      (await call('customer', 'PATCH', `/api/v1/skills/${skill.id}`, { enabled: false }))
        .statusCode,
    ).toBe(404);
  });
});
