import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('run inspector (phase 2)', () => {
  let app: FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };

  beforeEach(async () => {
    app = (await buildApp({ quiet: true })) as FastifyInstance & {
      kernel?: import('@triageai/kernel').Kernel;
    };
  });

  afterEach(async () => {
    await app.close();
  });

  async function insertPendingRun(): Promise<string> {
    const database = app.kernel!.database;
    const runId = ulid();
    await database.query(
      `INSERT INTO workflow_runs (id, workflow_id, workflow_version, trigger, status, input)
       VALUES ($1, 'echo.run', '0.1.0', 'manual', 'PENDING', $2)`,
      [runId, { text: 'inspect me' }],
    );
    return runId;
  }

  it('lists runs filtered by workflow and returns a detail view', async () => {
    const runId = await insertPendingRun();

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/system/runs?workflowId=echo.run&limit=5',
    });
    expect(list.statusCode).toBe(200);
    const runs = list.json() as Array<{ id: string; status: string }>;
    expect(runs.some((run) => run.id === runId && run.status === 'PENDING')).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/system/runs/${runId}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { run: { id: string }; stages: unknown[]; decisions: unknown[] };
    expect(body.run.id).toBe(runId);
    expect(body.stages).toEqual([]);
    expect(body.decisions).toEqual([]);
  });

  it('returns 404 for an unknown run', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/system/runs/${ulid()}` });
    expect(res.statusCode).toBe(404);
  });

  it('cancels a pending run once, idempotently reporting false afterwards', async () => {
    const runId = await insertPendingRun();

    const first = await app.inject({ method: 'POST', url: `/api/v1/system/runs/${runId}/cancel` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ runId, cancelled: true });

    const second = await app.inject({ method: 'POST', url: `/api/v1/system/runs/${runId}/cancel` });
    expect(second.json()).toEqual({ runId, cancelled: false });

    const rows = (await app.kernel!.database.query(
      `SELECT status FROM workflow_runs WHERE id = $1`,
      [runId],
    )) as Array<{ status: string }>;
    expect(rows[0]?.status).toBe('CANCELLED_PENDING');
  });
});

describeIfDb('metrics endpoint (phase 2)', () => {
  it('exposes prometheus text metrics', async () => {
    const app = (await buildApp({ quiet: true })) as FastifyInstance & {
      kernel?: import('@triageai/kernel').Kernel;
    };
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('triageai_runs_total');
      expect(res.body).toContain('triageai_queue_jobs');
      expect(res.body).toContain('process_resident_memory_bytes');
    } finally {
      await app.close();
    }
  });
});

describeIfDb('candidate corrections (phase 2 feedback core)', () => {
  it('records a proposed correction with provenance and lists it', async () => {
    const app = (await buildApp({ quiet: true })) as FastifyInstance & {
      kernel?: import('@triageai/kernel').Kernel;
    };
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/system/candidates',
        payload: { input: { text: 'hi' }, gold: { label: 'shipping' }, reason: 'misclassified' },
      });
      expect(created.statusCode).toBe(201);
      const candidate = created.json() as {
        id: string;
        status: string;
        provenance: { reason: string };
      };
      expect(candidate.status).toBe('proposed');
      expect(candidate.provenance.reason).toBe('misclassified');

      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/system/candidates?status=proposed',
      });
      expect(list.statusCode).toBe(200);
      const rows = list.json() as Array<{ id: string }>;
      expect(rows.some((row) => row.id === candidate.id)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describeIfDb('hardware monitor (phase 2)', () => {
  it('returns a host/runtime snapshot', async () => {
    const app = (await buildApp({ quiet: true })) as FastifyInstance & {
      kernel?: import('@triageai/kernel').Kernel;
    };
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system/hw' });
      expect(res.statusCode).toBe(200);
      const hw = res.json() as { cpuCount: number; processRssBytes: number; queuePending: number };
      expect(hw.cpuCount).toBeGreaterThan(0);
      expect(hw.processRssBytes).toBeGreaterThan(0);
      expect(hw.queuePending).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });
});
