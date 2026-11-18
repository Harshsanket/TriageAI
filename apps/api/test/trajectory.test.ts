import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import { TrajectoryMetricsSchema } from '@triageai/contracts';
import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { computeTrajectory, readTrajectory } from '../src/services/trajectory.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('trace-level trajectory evaluation (phase 18.T24)', () => {
  let app: FastifyInstance & { kernel?: Kernel };
  const runId = ulid();
  const pendingRunId = ulid();

  beforeAll(async () => {
    app = (await buildApp({ quiet: true })) as FastifyInstance & { kernel?: Kernel };
    const database = app.kernel!.database;
    await database.query(`DELETE FROM trajectory_metrics WHERE run_id IN ($1, $2)`, [
      runId,
      pendingRunId,
    ]);
    await database.query(`DELETE FROM workflow_runs WHERE id IN ($1, $2)`, [runId, pendingRunId]);

    await database.query(
      `INSERT INTO workflow_runs
         (id, workflow_id, workflow_version, trigger, status, input, output, finished_at)
       VALUES ($1, 'support.triage', '1', 'manual', 'SUCCEEDED', '{}'::jsonb, '{}'::jsonb, now())`,
      [runId],
    );
    await database.query(
      `INSERT INTO workflow_runs
         (id, workflow_id, workflow_version, trigger, status, input)
       VALUES ($1, 'support.triage', '1', 'manual', 'RUNNING', '{}'::jsonb)`,
      [pendingRunId],
    );

    const retrieve = ulid();
    const answer = ulid();
    const retrieveAgain = ulid();
    for (const stage of [
      { id: retrieve, stageId: 'retrieve', kind: 'kb.search', status: 'SUCCEEDED', attempts: 1 },
      { id: answer, stageId: 'answer', kind: 'ai.generate', status: 'FAILED', attempts: 2 },
      {
        id: retrieveAgain,
        stageId: 'retrieve',
        kind: 'kb.search',
        status: 'SUCCEEDED',
        attempts: 1,
      },
    ]) {
      await database.query(
        `INSERT INTO stage_runs (id, run_id, stage_id, kind, status, attempts, output, error, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, now(), now())`,
        [
          stage.id,
          runId,
          stage.stageId,
          stage.kind,
          stage.status,
          stage.attempts,
          stage.status === 'FAILED' ? 'generation failed' : null,
        ],
      );
    }
    await database.query(
      `INSERT INTO decision_records
         (id, run_id, stage_run_id, workflow_id, workflow_version, module_id, module_version,
          evidence, deterministic, outcome, error, fallback)
       VALUES
         ($1, $2, $3, 'support.triage', '1', 'support', '1',
          '{"tool":"kb.search"}'::jsonb, '{}'::jsonb, '{"used":false}'::jsonb, NULL, NULL),
         ($4, $2, $5, 'support.triage', '1', 'support', '1',
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{"message":"generation failed"}'::jsonb, '{"policy":"retry"}'::jsonb),
         ($6, $2, $7, 'support.triage', '1', 'support', '1',
          '{"tool":"kb.search"}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, NULL)`,
      [ulid(), runId, retrieve, ulid(), answer, ulid(), retrieveAgain],
    );
  });

  afterAll(async () => {
    if (app?.kernel) {
      await app.kernel.database.query(`DELETE FROM workflow_runs WHERE id IN ($1, $2)`, [
        runId,
        pendingRunId,
      ]);
    }
    await app?.close();
  });

  it('computes redundant/wasted steps and a deterministic score per stage', async () => {
    const metrics = await computeTrajectory(app.kernel!.database, runId, {
      reference: [
        { nodeId: 'retrieve', kind: 'retrieval' },
        { nodeId: 'answer', kind: 'stage' },
      ],
    });
    expect(metrics).toMatchObject({
      runId,
      steps: 3,
      redundantSteps: 1,
      wastedSteps: 1,
      firstFailingNode: 'answer',
    });
    expect(metrics.pathEfficiency).toBeCloseTo(2 / 3, 3);
    expect(metrics.scores).toHaveLength(3);
    expect(metrics.scores.find((score) => score.nodeId === 'answer')).toMatchObject({
      score: 0,
      passed: false,
    });
    expect(metrics.scores.filter((score) => score.nodeId === 'retrieve')[1]).toMatchObject({
      score: 0.5,
      passed: false,
    });
  });

  it('persists once on read and exposes the additive trajectory field', async () => {
    const first = await app.inject({ method: 'GET', url: `/api/v1/system/runs/${runId}` });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { trajectory: unknown };
    const trajectory = TrajectoryMetricsSchema.parse(firstBody.trajectory);
    expect(trajectory).toMatchObject({
      runId,
      steps: 3,
      redundantSteps: 1,
      wastedSteps: 1,
      firstFailingNode: 'answer',
    });
    expect(trajectory.pathEfficiency).toBeCloseTo(2 / 3, 3);

    const second = await app.inject({ method: 'GET', url: `/api/v1/system/runs/${runId}` });
    const secondBody = second.json() as { trajectory: { createdAt: string } };
    expect(secondBody.trajectory.createdAt).toBe(trajectory.createdAt);
    const rows = await app.kernel!.database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM trajectory_metrics WHERE run_id = $1`,
      [runId],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('leaves unfinished runs without a trajectory row', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/system/runs/${pendingRunId}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { trajectory: unknown }).trajectory).toBeNull();
    expect(await readTrajectory(app.kernel!.database, pendingRunId)).toBeNull();
  });

  it('feeds the dashboard trajectory tile', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      trajectory: {
        runs: number;
        wastedSteps: number;
        redundantSteps: number;
        mostCommonFailingStep: string | null;
      };
    };
    expect(body.trajectory.runs).toBeGreaterThanOrEqual(1);
    expect(body.trajectory.wastedSteps).toBeGreaterThanOrEqual(1);
    expect(body.trajectory.redundantSteps).toBeGreaterThanOrEqual(1);
    expect(body.trajectory.mostCommonFailingStep).toBe('answer');
  });
});
