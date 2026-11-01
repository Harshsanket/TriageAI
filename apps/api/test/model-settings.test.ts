import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';

import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const DB_NAME = 'triageai_model_settings_test';
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);

async function resetDatabase(): Promise<void> {
  const admin = new PostgresDatabase(BASE_URL);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.close();
  }
}

describeIfDb('model settings + danger actions (phase 11/19)', () => {
  let app: (FastifyInstance & { kernel?: import('@triageai/kernel').Kernel }) | undefined;

  beforeAll(resetDatabase, 60_000);
  afterAll(async () => {
    await app?.close();
    const admin = new PostgresDatabase(BASE_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => undefined);
    await admin.close();
  });

  it('reads, saves and resets model settings through the config overlay', async () => {
    let restarts = 0;
    app = await buildApp({
      quiet: true,
      databaseUrl: TEST_URL,
      setup: false,
      authMode: 'disabled',
      restart: () => {
        restarts += 1;
      },
      configPath: path.resolve(process.cwd(), '../../triage.config.json'),
    });

    const initial = await app.inject({ method: 'GET', url: '/api/v1/setup/model-settings' });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      generator: { temperature: expect.any(Number), timeoutMs: expect.any(Number) },
      chat: { maxAnswerTokens: 384 },
    });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/setup/model-settings',
      payload: {
        generator: {
          adapter: 'ollama',
          model: 'qwen2.5:1.5b',
          temperature: 0.7,
          maxTokens: 512,
          timeoutMs: 60000,
        },
        chat: { maxAnswerTokens: 512 },
        retriever: { threshold: 0.4, margin: 0.02 },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ saved: true, version: 1, restartRequired: true });

    const after = await app.inject({ method: 'GET', url: '/api/v1/setup/model-settings' });
    expect(after.json()).toMatchObject({
      generator: { temperature: 0.7, maxTokens: 512, timeoutMs: 60000 },
      chat: { maxAnswerTokens: 512 },
      retriever: { threshold: 0.4, margin: 0.02 },
    });

    const restart = await app.inject({ method: 'POST', url: '/api/v1/setup/restart' });
    expect(restart.statusCode).toBe(200);
    expect(restart.json()).toMatchObject({ restarting: true });
    expect(restarts).toBe(1);

    const rejected = await app.inject({
      method: 'PUT',
      url: '/api/v1/setup/model-settings',
      payload: { generator: { temperature: 3 } },
    });
    expect(rejected.statusCode).toBe(400);

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/reset',
      payload: { confirm: 'RESET' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ reset: true, version: 2, restartRequired: true });

    const unconfirmed = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/reset',
      payload: { confirm: 'nope' },
    });
    expect(unconfirmed.statusCode).toBe(400);
  });
});
