import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('system config catalog (18.T8)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ quiet: true, setup: false, authMode: 'disabled' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the control catalog and the current retention/hosted values', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      retention?: unknown;
      hosted?: unknown;
      controls?: {
        fields: string[];
        catalog: Record<string, { label: string; applies: string; danger?: boolean }>;
      };
    };
    expect(body.controls?.fields).toEqual(
      expect.arrayContaining(['profile', 'queue', 'retention', 'hosted']),
    );
    expect(body.controls?.catalog.profile).toMatchObject({ label: 'Profile', applies: 'restart' });
    expect(body.controls?.catalog.retention).toMatchObject({
      label: 'Retention',
      applies: 'immediately',
      danger: true,
    });
    expect(body.retention).toBeTruthy();
    expect(body.hosted).toBeTruthy();
  });

  it('exports a versioned config envelope (18.T3)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/config?export=1' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      version: number;
      exportedAt: string;
      config: { profile: string };
    };
    expect(body.version).toBe(1);
    expect(body.exportedAt).toBeTruthy();
    expect(body.config.profile).toBeTruthy();
  });
});
