import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';

describe('health routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp({ quiet: true, skipBoot: true });
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /healthz returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'api', version: expect.any(String) });
  });

  it('GET /readyz returns ready', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });
});

describe('error envelope', () => {
  it('keeps framework 4xx statuses instead of masking them as 500', async () => {
    const app = await buildApp({ quiet: true, skipBoot: true });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/healthz',
        headers: { 'content-type': 'application/json' },
        payload: '{not json',
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    } finally {
      await app.close();
    }
  });
});
