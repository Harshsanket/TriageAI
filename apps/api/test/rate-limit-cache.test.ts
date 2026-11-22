import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { MemoryCache } from '@triageai/kernel';
import type { Capabilities } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('cache-backed rate limits (18.T11)', () => {
  let app: FastifyInstance;
  let increments = 0;

  beforeAll(async () => {
    const memory = new MemoryCache();
    const cache: Capabilities['cache'] = {
      get: (key) => memory.get(key),
      set: (key, value, ttlMs) => memory.set(key, value, ttlMs),
      delete: (key) => memory.delete(key),
      increment: async (key, ttlMs) => {
        increments += 1;
        return memory.increment!(key, ttlMs);
      },
    };
    app = await buildApp({
      quiet: true,
      setup: false,
      authMode: 'disabled',
      rateLimit: { max: 2, timeWindow: '1 minute' },
      capabilities: { cache },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('uses the cache counter and returns 429 after the window limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(increments).toBeGreaterThanOrEqual(3);
  });
});
