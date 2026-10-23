import { describe, expect, it } from 'vitest';

import { PostgresDatabase } from '../src/storage.js';
import { WorkflowEngine } from '../src/workflow.js';
import type { KernelLogger, WorkflowDef } from '../src/types.js';

const noopLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

async function withEngine(
  fn: (engine: WorkflowEngine, database: PostgresDatabase) => Promise<void>,
): Promise<void> {
  const database = new PostgresDatabase(DATABASE_URL);
  const engine = new WorkflowEngine(database, noopLogger);
  try {
    await fn(engine, database);
  } finally {
    await database.close();
  }
}

async function runOf(database: PostgresDatabase, runId: string) {
  const rows = await database.query<{ status: string; error: string | null; output: unknown }>(
    `SELECT status, error, output FROM workflow_runs WHERE id = $1`,
    [runId],
  );
  return rows[0]!;
}

async function stagesOf(database: PostgresDatabase, runId: string) {
  return database.query<{
    stage_id: string;
    status: string;
    attempts: number;
    error: string | null;
  }>(
    `SELECT stage_id, status, attempts, error FROM stage_runs WHERE run_id = $1 ORDER BY created_at, stage_id`,
    [runId],
  );
}

async function decisionsOf(database: PostgresDatabase, runId: string) {
  return database.query<{ stage_run_id: string; fallback: unknown; outcome: unknown }>(
    `SELECT stage_run_id, fallback, outcome FROM decision_records WHERE run_id = $1 ORDER BY created_at`,
    [runId],
  );
}

function def(
  id: string,
  stages: WorkflowDef['stages'],
  extra: Partial<WorkflowDef> = {},
): WorkflowDef {
  return { id, version: '0.1.0', module: 'test', trigger: { type: 'endpoint' }, stages, ...extra };
}

describeIfDb('workflow engine (phase 2)', () => {
  it('2.1 skips stages on `when` and records SKIPPED + decision rows', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.emit', {
        execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
      });
      const wf = def('test.when', [
        { id: 'a', kind: 't.emit', input: { value: '$.flag' } },
        { id: 'b', kind: 't.emit', when: "${stages.a.output.value} == 'yes'" },
        { id: 'c', kind: 't.emit', when: "${stages.a.output.value} == 'no'" },
      ]);
      engine.register(wf, 'test', '0.1.0');
      await database.query(`DELETE FROM workflow_runs WHERE workflow_id = 'test.when'`);

      const { runId } = await engine.start('test.when', { flag: 'no' });
      await engine.processRun(runId);

      expect((await runOf(database, runId)).status).toBe('SUCCEEDED');
      const stages = await stagesOf(database, runId);
      expect(stages.map((s) => [s.stage_id, s.status])).toEqual([
        ['a', 'SUCCEEDED'],
        ['b', 'SKIPPED'],
        ['c', 'SUCCEEDED'],
      ]);
      expect(await decisionsOf(database, runId)).toHaveLength(3);
    });
  });

  it('2.1 resolves stage input refs from prior stages', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.upper', {
        execute: async (stage) => ({
          output: { upper: String(stage.input.text ?? '').toUpperCase() },
        }),
      });
      engine.registerStageHandler('t.wrap', {
        execute: async (stage) => ({ output: { wrapped: `[${stage.input.value}]` } }),
      });
      engine.register(
        def('test.refs', [
          { id: 'u', kind: 't.upper', input: { text: '$.text' } },
          { id: 'w', kind: 't.wrap', input: { value: '${stages.u.output.upper}' } },
        ]),
        'test',
        '0.1.0',
      );
      await database.query(`DELETE FROM workflow_runs WHERE workflow_id = 'test.refs'`);

      const { runId } = await engine.start('test.refs', { text: 'hi' });
      await engine.processRun(runId);

      const run = (await runOf(database, runId)) as { output: Record<string, { wrapped: string }> };
      expect(run.output.w?.wrapped).toBe('[HI]');
    });
  });

  it('2.2 retries a failing stage and records the attempt count', async () => {
    await withEngine(async (engine, database) => {
      let calls = 0;
      engine.registerStageHandler('t.flaky', {
        execute: async () => {
          calls += 1;
          if (calls < 2) throw new Error('transient');
          return { output: { ok: true } };
        },
      });
      engine.register(
        def('test.retry', [{ id: 'a', kind: 't.flaky', retry: { attempts: 2, backoffMs: [1] } }]),
        'test',
        '0.1.0',
      );
      await database.query(`DELETE FROM workflow_runs WHERE workflow_id = 'test.retry'`);

      const { runId } = await engine.start('test.retry', {});
      await engine.processRun(runId);

      expect((await runOf(database, runId)).status).toBe('SUCCEEDED');
      const stages = await stagesOf(database, runId);
      expect(stages[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    });
  });

  it('2.2 times out a slow stage and marks TIMED_OUT', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.slow', {
        execute: (stage) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ output: { late: true } }), 5000);
            stage.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              resolve({ output: { aborted: true } });
            });
          }),
      });
      engine.register(
        def('test.timeout', [{ id: 'a', kind: 't.slow', timeoutMs: 30 }]),
        'test',
        '0.1.0',
      );
      await database.query(`DELETE FROM workflow_runs WHERE workflow_id = 'test.timeout'`);

      const { runId } = await engine.start('test.timeout', {});
      await engine.processRun(runId);

      const run = await runOf(database, runId);
      expect(run.status).toBe('FAILED');
      expect(run.error).toContain('timed out');
      const stages = await stagesOf(database, runId);
      expect(stages[0]?.status).toBe('TIMED_OUT');
    });
  });

  it('2.3 cancels a running workflow, aborts the handler, and cascades', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.hang', {
        execute: (stage) =>
          new Promise((resolve) => {
            stage.signal.addEventListener('abort', () => resolve({ output: { aborted: true } }));
          }),
      });
      engine.register(
        def('test.cancel', [
          { id: 'a', kind: 't.hang' },
          { id: 'b', kind: 't.hang' },
        ]),
        'test',
        '0.1.0',
      );
      await database.query(`DELETE FROM workflow_runs WHERE workflow_id = 'test.cancel'`);

      const { runId } = await engine.start('test.cancel', {});
      const processing = engine.processRun(runId);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await engine.cancel(runId)).toBe(true);
      await processing;

      const run = await runOf(database, runId);
      expect(run.status).toBe('CANCELLED');
      const stages = await stagesOf(database, runId);
      expect(stages.map((s) => s.status)).toEqual(['CANCELLED', 'CANCELLED']);
      // cancel is idempotent-ish: already terminal -> false
      expect(await engine.cancel(runId)).toBe(false);
    });
  });

  it('2.4 retry_alternative_retrieval re-runs the stage once with alternate config', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.retrieve', {
        execute: async (stage) => {
          if (!stage.config._alternate) throw new Error('primary retrieval failed');
          return { output: { docs: ['alt'] }, evidence: { strategy: 'alternate' } };
        },
      });
      engine.register(
        def('test.fallback', [{ id: 'r', kind: 't.retrieve', onError: 'fallback' }], {
          fallbackPolicyId: 'retry_alternative_retrieval',
        }),
        'test',
        '0.1.0',
      );
      await database.query(`DELETE FROM workflow_runs WHERE workflow_id = 'test.fallback'`);

      const { runId } = await engine.start('test.fallback', {});
      await engine.processRun(runId);

      expect((await runOf(database, runId)).status).toBe('SUCCEEDED');
      const stages = await stagesOf(database, runId);
      expect(stages).toHaveLength(1);
      expect(stages[0]).toMatchObject({ status: 'SUCCEEDED', attempts: 2 });
    });
  });

  it('2.4 return_uncertain parks the run in AWAITING and records the fallback', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.bad', {
        execute: async () => {
          throw new Error('validation gate failed');
        },
      });
      engine.register(
        def('test.awaiting', [{ id: 'v', kind: 't.bad', onError: 'fallback' }], {
          fallbackPolicyId: 'return_uncertain',
        }),
        'test',
        '0.1.0',
      );
      await database.query(`DELETE FROM workflow_runs WHERE workflow_id = 'test.awaiting'`);

      const { runId } = await engine.start('test.awaiting', {});
      await engine.processRun(runId);

      expect((await runOf(database, runId)).status).toBe('AWAITING');
      const decisions = await decisionsOf(database, runId);
      expect(decisions[0]?.fallback).toMatchObject({ policyApplied: 'return_uncertain' });
    });
  });

  it('2.1/2.4 rejects invalid grammar and unknown fallback policies at start', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.noop', { execute: async () => ({ output: {} }) });
      engine.register(
        def('test.invalid-when', [{ id: 'a', kind: 't.noop', when: '${a.b} =~ /x/' }]),
        'test',
        '0.1.0',
      );
      await expect(engine.start('test.invalid-when', {})).rejects.toThrow(/invalid when/);

      engine.register(
        def('test.invalid-policy', [{ id: 'a', kind: 't.noop' }], { fallbackPolicyId: 'nope' }),
        'test',
        '0.1.0',
      );
      await expect(engine.start('test.invalid-policy', {})).rejects.toThrow(
        /unknown fallbackPolicyId/,
      );

      engine.register(
        def('test.fallback-no-policy', [{ id: 'a', kind: 't.noop', onError: 'fallback' }]),
        'test',
        '0.1.0',
      );
      await expect(engine.start('test.fallback-no-policy', {})).rejects.toThrow(
        /requires fallbackPolicyId/,
      );
      void database;
    });
  });
});
