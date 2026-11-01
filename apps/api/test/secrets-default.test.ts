import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('secret store default-on (phase 23.7)', () => {
  let app: FastifyInstance;
  let dir: string;
  const previousKey = process.env.TRIAGEAI_SECRET_KEY;
  const previousDir = process.env.TRIAGEAI_SECRETS_DIR;

  beforeAll(async () => {
    delete process.env.TRIAGEAI_SECRET_KEY;
    dir = mkdtempSync(join(tmpdir(), 'triageai-secret-default-'));
    process.env.TRIAGEAI_SECRETS_DIR = dir;
    app = await buildApp({ quiet: true, setup: false, authMode: 'disabled' });
  });

  afterAll(async () => {
    await app.close();
    if (previousKey === undefined) delete process.env.TRIAGEAI_SECRET_KEY;
    else process.env.TRIAGEAI_SECRET_KEY = previousKey;
    if (previousDir === undefined) delete process.env.TRIAGEAI_SECRETS_DIR;
    else process.env.TRIAGEAI_SECRETS_DIR = previousDir;
  });

  it('generates a 600 key file and stores a secret without TRIAGEAI_SECRET_KEY', async () => {
    expect(statSync(join(dir, 'master.key')).mode & 0o777).toBe(0o600);

    const initial = await app.inject({ method: 'GET', url: '/api/v1/setup/secrets' });
    expect(initial.json()).toMatchObject({ available: true });

    const value = 'super-secret-value-never-returned';
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/setup/secrets/TEST_DEFAULT_TOKEN',
      payload: { value },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(value);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/setup/secrets' });
    expect(listed.body).not.toContain(value);
    const body = listed.json() as {
      available: boolean;
      secrets: Array<{ name: string; lastUsedAt: string | null }>;
    };
    expect(body.available).toBe(true);
    expect(body.secrets.find((entry) => entry.name === 'TEST_DEFAULT_TOKEN')).toMatchObject({
      lastUsedAt: null,
    });
  });
});
