import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { PostgresDatabase } from '@triageai/kernel';

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
    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-processing',
      payload: { chunking: 'structure-700', pdfExtraction: 'text-layer', imageExtraction: 'skip' },
    });
    await app.close();
  });

  it('saves data-processing strategies and rejects unknown ones', async () => {
    const defaults = await app.inject({
      method: 'GET',
      url: '/api/v1/system/data-processing',
    });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toMatchObject({
      chunking: 'structure-700',
      pdfExtraction: 'text-layer',
      imageExtraction: 'skip',
    });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-processing',
      payload: {
        chunking: 'sentence-500',
        pdfExtraction: 'text-layer-strict',
        imageExtraction: 'metadata',
      },
    });
    expect(saved.statusCode).toBe(200);
    const reread = await app.inject({
      method: 'GET',
      url: '/api/v1/system/data-processing',
    });
    expect(reread.json()).toMatchObject({
      chunking: 'sentence-500',
      pdfExtraction: 'text-layer-strict',
      imageExtraction: 'metadata',
    });

    const refused = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/data-processing',
      payload: { chunking: 'semantic' },
    });
    expect(refused.statusCode).toBe(400);
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
      { overrides: { support_tickets: { retentionDays: 10 } } },
      { overrides: { secrets: { modelUse: 'allowed' } } },
      { overrides: { audit_events: { modelUse: 'local_only' } } },
    ]) {
      const refused = await app.inject({
        method: 'PUT',
        url: '/api/v1/system/data-policy',
        payload,
      });
      expect(refused.statusCode).toBe(400);
    }
  });

  it('reports persisted send-gate counters from model traces (18.T18)', async () => {
    const database = new PostgresDatabase(
      process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai',
    );
    const baseline = (
      await app.inject({ method: 'GET', url: '/api/v1/system/data-policy' })
    ).json() as {
      sendGate: { sent: number; redacted: number; withheld: number };
    };
    const traceId = `send-gate-${Date.now()}`;
    await database.query(
      `INSERT INTO model_call_traces (trace_id, run_id, task, trace) VALUES ($1, $2, $3, $4)`,
      [
        traceId,
        'run-send-gate',
        'chat',
        {
          securityEvents: [
            'send_gate:allowed',
            'send_gate:redacted:pii_or_internal_redaction',
            'send_gate:withheld:secret',
          ],
        },
      ],
    );
    try {
      const after = (
        await app.inject({ method: 'GET', url: '/api/v1/system/data-policy' })
      ).json() as {
        sendGate: { sent: number; redacted: number; withheld: number };
      };
      expect(after.sendGate.sent).toBe(baseline.sendGate.sent + 1);
      expect(after.sendGate.redacted).toBe(baseline.sendGate.redacted + 1);
      expect(after.sendGate.withheld).toBe(baseline.sendGate.withheld + 1);
    } finally {
      await database.query(`DELETE FROM model_call_traces WHERE trace_id = $1`, [traceId]);
      await database.close();
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
