import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import type { Kernel } from '@triageai/kernel';

import { registerMetricsRoute } from '../src/routes/metrics.js';

function kernelWith(query: (text: string) => Promise<unknown[]>): Kernel {
  return { database: { query } } as unknown as Kernel;
}

describe('/metrics database failures (phase 10c)', () => {
  it('ignores only a missing optional table (Postgres 42P01)', async () => {
    const app = Fastify({ logger: false });
    registerMetricsRoute(
      app,
      kernelWith(async (text) => {
        if (text.includes('support_auto_replies')) {
          throw Object.assign(new Error('relation "support_auto_replies" does not exist'), {
            code: '42P01',
          });
        }
        return [];
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('triageai_decisions_total');
    await app.close();
  });

  it('fails loudly when the database is unavailable', async () => {
    const app = Fastify({ logger: false });
    registerMetricsRoute(
      app,
      kernelWith(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
          code: 'ECONNREFUSED',
        });
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
