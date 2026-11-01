import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

let app: App;
beforeEach(async () => {
  app = (await buildApp({
    quiet: true,
    configPath: resolve(process.cwd(), '../../triage.config.json'),
  })) as App;
});
afterEach(async () => {
  await app.close();
});

describeIfDb('alerts endpoint (phase 18)', () => {
  it('returns evaluated alerts from live tables', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/alerts' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      generatedAt: expect.any(String),
      alerts: expect.any(Array),
    });
  });
});
