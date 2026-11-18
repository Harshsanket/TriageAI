import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CORE_MIGRATIONS } from '../src/migrations.js';
import { InlineQueue } from '../src/queue/inline.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { ScheduleStarter } from '../src/scheduler/scheduler.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type { ChatModel, KernelLogger, WorkflowDef } from '../src/types.js';
import { WorkflowEngine } from '../src/workflow.js';

const noopLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

const FIXED = new Date('2026-11-11T10:00:30.000Z');
const IDS = [
  'test.scheduler.once',
  'test.scheduler.overlap',
  'test.scheduler.probe',
  'test.scheduler.empty',
];

function scheduleDef(
  id: string,
  config: Record<string, unknown> = { cron: '* * * * *' },
): WorkflowDef {
  return {
    id,
    version: '0.1.0',
    module: 'test',
    trigger: { type: 'schedule', config },
    stages: [{ id: 'run', kind: 'test.scheduler.step' }],
  };
}

describeIfDb('kernel scheduler (18.T4/18.T33)', () => {
  let database: PostgresDatabase;
  let engine: WorkflowEngine;
  let queue: InlineQueue;
  let scheduler: Scheduler;
  let handlers: Map<string, () => Promise<Record<string, unknown>>>;
  let modelCalls: string[];

  const starter: ScheduleStarter = async (workflowId, input, opts) => {
    const candidate = await engine.start(workflowId, input, opts);
    if (!candidate.deduped) {
      await queue.enqueue(
        'workflow.run',
        { runId: candidate.runId },
        {
          idempotencyKey: `run:${candidate.runId}`,
          priority: opts?.trigger === 'schedule' ? 0 : 1,
        },
      );
    }
    return candidate;
  };

  beforeEach(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
    await database.query(`DELETE FROM schedule_runs WHERE schedule_id = ANY($1)`, [IDS]);
    await database.query(`DELETE FROM schedule_state WHERE schedule_id = ANY($1)`, [IDS]);
    await database.query(`DELETE FROM workflow_runs WHERE workflow_id = ANY($1)`, [IDS]);
    modelCalls = [];
    const model: ChatModel = {
      async chat() {
        modelCalls.push('called');
        throw new Error('the model must not be called for a no_change occurrence');
      },
      describe: () => ({
        provider: 'test',
        model: 'test-model',
        hosted: false,
        contextWindow: 4096,
        maxOutput: 512,
        supportsTools: false,
        supportsStreaming: false,
      }),
    };
    engine = new WorkflowEngine(
      database,
      noopLogger,
      undefined,
      undefined,
      {},
      {
        chatModel: () => model,
      },
    );
    queue = new InlineQueue(noopLogger);
    queue.subscribe('workflow.run', async (payload) => {
      const { runId } = payload as { runId: string };
      await engine.processRun(runId);
    });
    handlers = new Map();
    engine.registerStageHandler('test.scheduler.step', {
      execute: async () => {
        const handler = handlers.get('current');
        return { output: handler ? await handler() : { sent: [{ id: 1 }] } };
      },
    });
    scheduler = new Scheduler({
      database,
      engine,
      startWorkflow: starter,
      logger: noopLogger,
      now: () => FIXED,
      pollIntervalMs: 60 * 60_000,
      runPollMs: 10,
    });
  });

  afterEach(async () => {
    await scheduler.stop();
    await queue.close();
    await database.close();
  });

  it('starts a due workflow once with a deterministic idempotency key', async () => {
    engine.register(scheduleDef('test.scheduler.once'), 'test', '0.1.0');
    await scheduler.start();

    await scheduler.tick(new Date(FIXED.getTime() + 30_000));
    await scheduler.waitForIdle();

    const runs = await database.query<{
      id: string;
      trigger: string;
      status: string;
      idempotency_key: string;
      input: { __schedule?: { trigger?: string } };
    }>(
      `SELECT id, trigger, status, idempotency_key, input
         FROM workflow_runs WHERE workflow_id = 'test.scheduler.once'`,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: 'schedule',
      status: 'SUCCEEDED',
      idempotency_key: 'schedule:test.scheduler.once:2026-11-11T10:01:00.000Z',
    });
    expect(runs[0]?.input.__schedule?.trigger).toBe('schedule');
    expect(JSON.stringify(runs[0]?.input)).not.toContain('history');

    const state = await scheduler.state('test.scheduler.once');
    expect(state?.lastStatus).toBe('succeeded');
    expect(state?.skippedOverlap).toBe(0);
    const history = await database.query<{ outcome: string; useful: boolean; run_id: string }>(
      `SELECT outcome, useful, run_id FROM schedule_runs WHERE schedule_id = 'test.scheduler.once'`,
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ outcome: 'succeeded', useful: true });

    // Same bucket again: the idempotency key returns the existing run.
    await scheduler.tick(new Date(FIXED.getTime() + 60_000));
    await scheduler.waitForIdle();
    const again = await database.query(`SELECT id FROM workflow_runs WHERE workflow_id = $1`, [
      'test.scheduler.once',
    ]);
    expect(again).toHaveLength(1);

    // A fresh scheduler (restart) dedupes the same bucket as well.
    const restarted = new Scheduler({
      database,
      engine,
      startWorkflow: starter,
      logger: noopLogger,
      now: () => FIXED,
      pollIntervalMs: 60 * 60_000,
      runPollMs: 10,
    });
    await restarted.start();
    await restarted.tick(new Date(FIXED.getTime() + 30_000));
    await restarted.waitForIdle();
    expect((await restarted.state('test.scheduler.once'))?.lastStatus).toBe('deduped');
    await restarted.stop();
    const afterRestart = await database.query(
      `SELECT id FROM workflow_runs WHERE workflow_id = $1`,
      ['test.scheduler.once'],
    );
    expect(afterRestart).toHaveLength(1);
  });

  it('skips and records an overlapping occurrence instead of queueing it', async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    handlers.set('current', async () => {
      started?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { sent: [{ id: 2 }] };
    });
    engine.register(scheduleDef('test.scheduler.overlap'), 'test', '0.1.0');
    await scheduler.start();

    await scheduler.tick(new Date(FIXED.getTime() + 30_000));
    await startedPromise;
    await scheduler.tick(new Date(FIXED.getTime() + 90_000));

    const state = await scheduler.state('test.scheduler.overlap');
    expect(state?.skippedOverlap).toBe(1);
    const history = await database.query<{ outcome: string }>(
      `SELECT outcome FROM schedule_runs WHERE schedule_id = 'test.scheduler.overlap' ORDER BY started_at`,
    );
    expect(history.map((row) => row.outcome).sort()).toEqual(['skipped_overlap', 'started']);

    release?.();
    await scheduler.waitForIdle();
    const runs = await database.query(`SELECT id FROM workflow_runs WHERE workflow_id = $1`, [
      'test.scheduler.overlap',
    ]);
    expect(runs).toHaveLength(1);
  });

  it('does not run when the probe watermark is unchanged, and advances it after success', async () => {
    let watermark = '42';
    engine.register(
      scheduleDef('test.scheduler.probe', {
        cron: '* * * * *',
        probe: { kind: 'watermark', read: 'test:watermark' },
      }),
      'test',
      '0.1.0',
    );
    await database.query(
      `INSERT INTO schedule_state (schedule_id, workflow_id, watermark)
       VALUES ('test.scheduler.probe', 'test.scheduler.probe', $1)`,
      [{ value: '42' }],
    );
    const probed = new Scheduler({
      database,
      engine,
      startWorkflow: starter,
      logger: noopLogger,
      now: () => FIXED,
      pollIntervalMs: 60 * 60_000,
      runPollMs: 10,
      probeReaders: { 'test:watermark': async () => watermark },
    });
    await probed.start();

    await probed.tick(new Date(FIXED.getTime() + 30_000));
    await probed.waitForIdle();
    let runs = await database.query(`SELECT id FROM workflow_runs WHERE workflow_id = $1`, [
      'test.scheduler.probe',
    ]);
    expect(runs).toHaveLength(0);
    expect((await probed.state('test.scheduler.probe'))?.lastStatus).toBe('no_change');
    const noChange = await database.query<{ outcome: string }>(
      `SELECT outcome FROM schedule_runs WHERE schedule_id = 'test.scheduler.probe'`,
    );
    expect(noChange).toEqual([{ outcome: 'no_change' }]);

    watermark = '43';
    await probed.tick(new Date(FIXED.getTime() + 90_000));
    await probed.waitForIdle();
    runs = await database.query(`SELECT id FROM workflow_runs WHERE workflow_id = $1`, [
      'test.scheduler.probe',
    ]);
    expect(runs).toHaveLength(1);
    expect((await probed.state('test.scheduler.probe'))?.watermark).toEqual({ value: '43' });
    expect((await probed.state('test.scheduler.probe'))?.lastStatus).toBe('succeeded');
    await probed.stop();
  });

  it('makes zero model calls when the probe is unchanged', async () => {
    const id = 'test.scheduler.probe';
    const version = '0.1.0';
    engine.register(
      {
        id,
        version,
        module: 'test',
        trigger: {
          type: 'schedule',
          config: {
            cron: '* * * * *',
            probe: { kind: 'watermark', read: 'test:watermark' },
          },
        },
        stages: [],
        graph: {
          id,
          version,
          module: 'test',
          trigger: {
            type: 'schedule',
            schedule: {
              cron: '* * * * *',
              probe: { kind: 'watermark', read: 'test:watermark' },
              overlap: 'skip',
              silentWhenEmpty: true,
            },
          },
          start: 'decide',
          nodes: [
            { id: 'decide', type: 'llm_decision', labels: ['go'] },
            { id: 'end', type: 'end', end: 'succeeded' },
          ],
          edges: [{ from: 'decide', to: 'end', label: 'go', isDefault: true }],
          defaultErrorEdge: { to: 'end' },
          budget: { maxSteps: 10, maxDurationMs: 10_000 },
          executionStyleReason: 'one bounded model choice per wake-up',
        },
      },
      'test',
      version,
    );
    await database.query(
      `INSERT INTO schedule_state (schedule_id, workflow_id, watermark)
       VALUES ($1, $1, $2)`,
      [id, { value: '7' }],
    );
    const probed = new Scheduler({
      database,
      engine,
      startWorkflow: starter,
      logger: noopLogger,
      now: () => FIXED,
      pollIntervalMs: 60 * 60_000,
      runPollMs: 10,
      probeReaders: { 'test:watermark': async () => '7' },
    });
    await probed.start();
    await probed.tick(new Date(FIXED.getTime() + 30_000));
    await probed.waitForIdle();
    expect(modelCalls).toEqual([]);
    const runs = await database.query(`SELECT id FROM workflow_runs WHERE workflow_id = $1`, [id]);
    expect(runs).toHaveLength(0);
    await probed.stop();
  });

  it('keeps the watermark when a changed run fails', async () => {
    let watermark = '1';
    handlers.set('current', async () => {
      throw new Error('boom');
    });
    engine.register(
      scheduleDef('test.scheduler.probe', {
        cron: '* * * * *',
        probe: { kind: 'watermark', read: 'test:watermark' },
      }),
      'test',
      '0.1.0',
    );
    await database.query(
      `INSERT INTO schedule_state (schedule_id, workflow_id, watermark)
       VALUES ('test.scheduler.probe', 'test.scheduler.probe', $1)`,
      [{ value: '0' }],
    );
    const probed = new Scheduler({
      database,
      engine,
      startWorkflow: starter,
      logger: noopLogger,
      now: () => FIXED,
      pollIntervalMs: 60 * 60_000,
      runPollMs: 10,
      probeReaders: { 'test:watermark': async () => watermark },
    });
    await probed.start();
    await probed.tick(new Date(FIXED.getTime() + 30_000));
    await probed.waitForIdle();
    const state = await probed.state('test.scheduler.probe');
    expect(state?.watermark).toEqual({ value: '0' });
    expect(state?.lastStatus).toBe('failed');
    await probed.stop();
    watermark = '2';
  });

  it('marks an empty successful run as empty and not useful (silent when empty)', async () => {
    handlers.set('current', async () => ({}));
    engine.register(scheduleDef('test.scheduler.empty'), 'test', '0.1.0');
    await scheduler.start();
    await scheduler.tick(new Date(FIXED.getTime() + 30_000));
    await scheduler.waitForIdle();
    const history = await database.query<{
      outcome: string;
      useful: boolean;
      output_empty: boolean;
    }>(
      `SELECT outcome, useful, output_empty FROM schedule_runs WHERE schedule_id = 'test.scheduler.empty'`,
    );
    expect(history[0]).toMatchObject({ outcome: 'empty', useful: false, output_empty: true });
  });

  it('marks a manual run separately and does not consume the cron slot', async () => {
    engine.register(scheduleDef('test.scheduler.once'), 'test', '0.1.0');
    await scheduler.start();
    const manual = await scheduler.runNow('test.scheduler.once', { actor: 'admin@test' });
    await scheduler.waitForIdle();
    const runs = await database.query<{ id: string; trigger: string }>(
      `SELECT id, trigger FROM workflow_runs WHERE workflow_id = 'test.scheduler.once'`,
    );
    expect(runs).toEqual([{ id: manual.runId, trigger: 'manual' }]);
    const history = await database.query<{ manual: boolean; outcome: string }>(
      `SELECT manual, outcome FROM schedule_runs WHERE schedule_id = 'test.scheduler.once'`,
    );
    expect(history[0]?.manual).toBe(true);
    expect(history[0]?.outcome).toBe('succeeded');
  });
});
