import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('custom data policy (phase 23.6)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ quiet: true, setup: false, authMode: 'disabled' });
    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-policy',
      payload: { reset: true },
    });
  });

  afterAll(async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-policy',
      payload: { reset: true },
    });
    await app.close();
  });

  it('saves an in-bounds override and refuses out-of-bounds values', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-policy',
      payload: { overrides: { support_tickets: { retentionDays: 30, modelUse: 'never' } } },
    });
    expect(saved.statusCode).toBe(200);
    const body = saved.json() as {
      classes: Array<{ id: string; custom: boolean; effective: { retentionDays: number | null } }>;
      version: number;
    };
    const ticketClass = body.classes.find((entry) => entry.id === 'support_tickets');
    expect(ticketClass).toMatchObject({ custom: true, effective: { retentionDays: 30 } });
    expect(body.version).toBeGreaterThan(0);

    for (const payload of [
      { overrides: { support_tickets: { retentionDays: 99_999 } } },
      { overrides: { secrets: { modelUse: 'allowed' } } },
    ]) {
      const refused = await app.inject({
        method: 'PUT',
        url: '/api/v1/system/data-policy',
        payload,
      });
      expect(refused.statusCode).toBe(400);
    }
  });

  it('switches and resets a named policy preset', async () => {
    const named = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-policy',
      payload: {
        overrides: { support_tickets: { retentionDays: 60 } },
        savePreset: 'Strict',
      },
    });
    expect(named.statusCode).toBe(200);
    expect(named.json()).toMatchObject({ activePreset: 'Strict', presets: ['Strict'] });

    const reset = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-policy',
      payload: { reset: true },
    });
    expect(reset.json()).toMatchObject({ activePreset: null });
    const applied = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-policy',
      payload: { applyPreset: 'Strict' },
    });
    expect(applied.json()).toMatchObject({ activePreset: 'Strict' });
  });
});
