import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, Kernel } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { loginRateLimitKey } from '../src/platform/auth/index.js';
import { explicitRuleFor } from '../src/platform/auth/rbac.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

const capabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({
      vectors: texts.map(() => [0.1, 0.2, 0.3]),
      modelVersion: 'fake',
    }),
  },
};

describeIfDb('auth hardening (phase 21)', () => {
  let dir: string;
  let echoConfig: string;
  let publicConfig: string;
  let database: PostgresDatabase;
  let app: FastifyInstance & { kernel?: Kernel };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'triageai-auth21-'));
    echoConfig = path.join(dir, 'echo.json');
    publicConfig = path.join(dir, 'public.json');
    await writeFile(
      echoConfig,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'inline' },
        modules: {},
        capabilities: {},
      }),
    );
    await writeFile(
      publicConfig,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'inline' },
        modules: { 'public-api': { enabled: true }, 'ai-pipeline': { enabled: true } },
        capabilities: {},
      }),
    );
    database = new PostgresDatabase(DATABASE_URL);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM mod_public_api.public_api_keys WHERE name LIKE 'auth21-%'`);
    await app?.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('does not treat an anonymous public caller as an admin (R1)', async () => {
    app = (await buildApp({
      quiet: true,
      configPath: echoConfig,
      setup: false,
      authMode: 'required',
    })) as FastifyInstance & { kernel?: Kernel };
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/github/webhook',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).not.toHaveProperty('detail');
    await app.close();
  });

  it('accepts a public-API key without trying to verify it as a JWT (R2)', async () => {
    app = (await buildApp({
      quiet: true,
      configPath: publicConfig,
      setup: false,
      authMode: 'disabled',
      capabilities,
    })) as FastifyInstance & { kernel?: Kernel };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/public-api/keys',
      payload: { name: `auth21-${Date.now()}`, scopes: ['embeddings'] },
    });
    expect(created.statusCode).toBe(200);
    const key = (created.json() as { key: string }).key;
    await app.close();

    app = (await buildApp({
      quiet: true,
      configPath: publicConfig,
      setup: false,
      authMode: 'required',
      capabilities,
    })) as FastifyInstance & { kernel?: Kernel };
    const res = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${key}` },
      payload: { input: 'hello' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: unknown[] }).data).toHaveLength(1);
  });

  it('keeps the audit log admin-only and lets owners cancel their own jobs (R15)', () => {
    expect(explicitRuleFor('GET', '/api/v1/system/audit')?.roles).toEqual(['admin']);
    expect(explicitRuleFor('POST', '/api/v1/system/jobs/job-1/cancel')?.roles).toEqual([
      'customer',
      'agent',
      'admin',
    ]);
  });

  it('keys login limits by IP + email (R3)', () => {
    expect(
      loginRateLimitKey({
        ip: '203.0.113.7',
        body: { email: 'a@test.dev' },
      } as never),
    ).toBe('203.0.113.7:a@test.dev');
    expect(
      loginRateLimitKey({ ip: '203.0.113.8', body: { email: 'a@test.dev' } } as never),
    ).not.toBe('203.0.113.7:a@test.dev');
  });
});
