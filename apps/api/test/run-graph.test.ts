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

describeIfDb('run graph endpoint (phase 18)', () => {
  it('lists declared workflows with their graphs for /config', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/workflows' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      workflows: Array<{ id: string; version: string; graph?: { nodes: unknown[] } }>;
    };
    const echo = body.workflows.find((workflow) => workflow.id === 'echo.run');
    expect(echo?.version).toBe('0.1.0');
    expect(echo?.graph?.nodes.length).toBeGreaterThan(0);
  });

  it('flags a run through the audited endpoint', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/echo/run',
      payload: { text: 'flag me' },
    });
    const { runId } = created.json() as { runId: string };
    const flagged = await app.inject({
      method: 'POST',
      url: `/api/v1/system/runs/${runId}/flag`,
      payload: { reason: 'wrong answer' },
    });
    expect(flagged.statusCode).toBe(200);
    expect(flagged.json()).toMatchObject({ runId, flagged: true });
    const audit = await app.kernel!.database.query<{ action: string; subject: string }>(
      `SELECT action, subject FROM audit_events WHERE action = 'run.flagged' AND subject = $1`,
      [runId],
    );
    expect(audit[0]?.subject).toBe(runId);

    // 18.T30: feedback/eval scores attach to the run's latest model trace.
    await app.kernel!.database.query(
      `INSERT INTO model_call_traces (trace_id, run_id, task, trace)
       VALUES ($2, $1, 'answer', '{"provider":"local"}'::jsonb)`,
      [runId, `trace-${runId}`],
    );
    const attached = await app.inject({
      method: 'POST',
      url: `/api/v1/system/runs/${runId}/flag`,
      payload: {
        feedback: { verdict: 'wrong', note: 'bad citation' },
        evalScores: [{ evaluator: 'groundedness', score: 0.4 }],
      },
    });
    expect(attached.statusCode).toBe(200);
    const traces = await app.kernel!.database.query<{
      trace: { userFeedback?: { verdict: string }; evalScores?: Array<{ score: number }> };
    }>(`SELECT trace FROM model_call_traces WHERE trace_id = $1`, [`trace-${runId}`]);
    expect(traces[0]?.trace.userFeedback?.verdict).toBe('wrong');
    expect(traces[0]?.trace.evalScores?.[0]?.score).toBe(0.4);
  });

  it('exports a run as a versioned envelope with pinned versions (18.T3)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/echo/run',
      payload: { text: 'export me' },
    });
    const { runId } = created.json() as { runId: string };
    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/system/runs/${runId}?export=1`,
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toMatchObject({
      version: 1,
      pinnedVersions: expect.any(Object),
      run: { id: runId },
    });
  });

  it('returns the compiled graph and the taken path for a run', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/echo/run',
      payload: { text: 'graph me' },
    });
    expect(created.statusCode).toBe(200);
    const { runId } = created.json() as { runId: string };
    const res = await app.inject({ method: 'GET', url: `/api/v1/system/runs/${runId}/graph` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      workflowId: string;
      graph: { nodes: Array<{ id: string }> };
      takenEdges: string[];
    };
    expect(body.workflowId).toBe('echo.run');
    expect(body.graph.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(body.takenEdges)).toBe(true);
  });
});
