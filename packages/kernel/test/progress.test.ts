import { describe, expect, it } from 'vitest';

import type { EventBus } from '../src/eventbus.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type { KernelLogger } from '../src/types.js';
import { WorkflowEngine } from '../src/workflow.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeIfDb('generic job progress (phase 20.1)', () => {
  it('persists progress, emits run.progress and marks the job terminal', async () => {
    const database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
    const events: Array<{ event: string; payload: unknown }> = [];
    const bus: EventBus = {
      async publish(event, payload) {
        events.push({ event, payload });
      },
      subscribe: () => undefined,
    };
    const engine = new WorkflowEngine(database, logger, bus);
    engine.registerStageHandler('test.progress', {
      async execute(stage) {
        await stage.reportProgress({
          done: 1,
          total: 2,
          unit: 'items',
          stage: 'extracting',
        });
        await stage.reportProgress({
          done: 2,
          total: 2,
          unit: 'items',
          stage: 'done',
        });
        return { output: { ok: true } };
      },
    });
    engine.register(
      {
        id: 'test.progress_flow',
        version: '0.1.0',
        module: 'test',
        trigger: { type: 'manual' },
        stages: [{ id: 'one', kind: 'test.progress' }],
      },
      'test',
      '0.1.0',
    );
    await database.query(`DELETE FROM job_progress WHERE workflow_id = 'test.progress_flow'`);
    const started = await engine.start(
      'test.progress_flow',
      {},
      { ownerId: 'user-1', title: 'Importing 2 items', total: 2, unit: 'items' },
    );
    await engine.processRun(started.runId);

    const rows = await database.query<{
      status: string;
      done: number;
      total: number;
      owner_id: string;
      title: string;
    }>(`SELECT status, done, total, owner_id, title FROM job_progress WHERE job_id = $1`, [
      started.runId,
    ]);
    expect(rows[0]).toMatchObject({
      status: 'succeeded',
      done: 2,
      total: 2,
      owner_id: 'user-1',
      title: 'Importing 2 items',
    });
    expect(events.filter((entry) => entry.event === 'run.progress')).toHaveLength(2);
    expect(events.find((entry) => entry.event === 'run.progress')?.payload).toMatchObject({
      runId: started.runId,
      done: 1,
      total: 2,
      unit: 'items',
      stage: 'extracting',
    });

    const run = await database.query<{ owner_id: string }>(
      `SELECT owner_id FROM workflow_runs WHERE id = $1`,
      [started.runId],
    );
    expect(run[0]?.owner_id).toBe('user-1');

    await database.query(`DELETE FROM job_progress WHERE job_id = $1`, [started.runId]);
    await database.query(`DELETE FROM workflow_runs WHERE id = $1`, [started.runId]);
    await database.close();
  });

  it('keeps a partial status reported by the handler instead of overwriting it', async () => {
    const database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
    const engine = new WorkflowEngine(database, logger);
    engine.registerStageHandler('test.partial', {
      async execute(stage) {
        await stage.reportProgress({ done: 1, total: 1, status: 'partial' });
        return { output: {} };
      },
    });
    engine.register(
      {
        id: 'test.partial_flow',
        version: '0.1.0',
        module: 'test',
        trigger: { type: 'manual' },
        stages: [{ id: 'one', kind: 'test.partial' }],
      },
      'test',
      '0.1.0',
    );
    const started = await engine.start('test.partial_flow', {}, { title: 'partial', total: 1 });
    await engine.processRun(started.runId);
    const rows = await database.query<{ status: string }>(
      `SELECT status FROM job_progress WHERE job_id = $1`,
      [started.runId],
    );
    expect(rows[0]?.status).toBe('partial');
    await database.query(`DELETE FROM job_progress WHERE job_id = $1`, [started.runId]);
    await database.query(`DELETE FROM workflow_runs WHERE id = $1`, [started.runId]);
    await database.close();
  });
});
