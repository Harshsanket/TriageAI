import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import type { ActivityQuery } from '@triageai/contracts';
import {
  parseActivityPhrase,
  queryActivity,
  recordActivity,
  resolveActivityQuery,
} from '../src/activity/index.js';
import { bootKernel } from '../src/kernel.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type {
  ChatModel,
  ChatRequest,
  Database,
  KernelContext,
  KernelLogger,
  TriageModule,
} from '../src/types.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function model(content: string): ChatModel & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async chat(_request: ChatRequest) {
      state.calls += 1;
      return {
        message: { role: 'assistant', content },
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end',
        modelVersion: 'fake',
      };
    },
    describe() {
      return {
        provider: 'fake',
        model: 'fake',
        hosted: false,
        contextWindow: 4096,
        maxOutput: 512,
        supportsTools: false,
        supportsStreaming: false,
      };
    },
  };
}

describe('activity phrase parsing (phase 18.6)', () => {
  const now = new Date('2026-11-11T12:00:00Z');

  it('parses dates deterministically before any model', () => {
    const query = parseActivityPhrase('what work was done yesterday', now);
    expect(query).toMatchObject({
      timeRange: { from: '2026-11-10T00:00:00.000Z', to: '2026-11-11T00:00:00.000Z' },
    });
    expect(query?.text).toBeUndefined();
  });

  it('extracts activity kinds and keywords', () => {
    expect(parseActivityPhrase('billing tickets closed last week', now)).toMatchObject({
      kinds: ['ticket'],
      text: 'billing closed',
    });
  });

  it('returns null when nothing is deterministic', () => {
    expect(parseActivityPhrase('what happened', now)).toBeNull();
  });
});

describe('activity query resolution (phase 18.6)', () => {
  const now = new Date('2026-11-11T12:00:00Z');

  it('uses exactly one model call when the deterministic pass cannot resolve', async () => {
    const chatModel = model(
      JSON.stringify({
        timeRange: { from: '2026-11-03T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z' },
        kinds: ['run'],
        text: 'billing',
      }),
    );
    const result = await resolveActivityQuery({
      phrase: 'billing runs last Tuesday',
      now,
      chatModel,
    });
    expect(result.source).toBe('model');
    expect(chatModel.calls).toBe(1);
    expect(result.query).toMatchObject({ kinds: ['run'], text: 'billing' });
  });

  it('never calls the model when the LLM switch is off', async () => {
    const chatModel = model('{}');
    const result = await resolveActivityQuery({
      phrase: 'billing runs last Tuesday',
      now,
      chatModel,
      llmDisabled: true,
    });
    expect(result.source).toBe('keyword');
    expect(chatModel.calls).toBe(0);
    expect(result.query.text).toBe('billing runs last Tuesday');
  });

  it('falls back to keyword search on an invalid model output', async () => {
    const chatModel = model('not json');
    const result = await resolveActivityQuery({
      phrase: 'billing runs last Tuesday',
      now,
      chatModel,
    });
    expect(result.source).toBe('keyword');
    expect(chatModel.calls).toBe(2); // one attempt + the wrapper's single repair
  });
});

describeIfDb('activity store (phase 18.6)', () => {
  let database: PostgresDatabase;
  const prefix = `activity-${Date.now()}`;

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
    await database.query(`DELETE FROM activity_events WHERE actor LIKE $1`, [`${prefix}%`]);
    await recordActivity(database, {
      at: '2099-01-10T09:00:00Z',
      actor: `${prefix}-alice`,
      kind: 'run',
      subject: `${prefix}-run-1`,
      summary: 'run SUCCEEDED: billing sync',
      refs: [`${prefix}-run-1`, 'billing'],
    });
    await recordActivity(database, {
      at: '2099-01-10T10:00:00Z',
      actor: `${prefix}-bob`,
      kind: 'approval',
      subject: `${prefix}-approval-1`,
      summary: 'approval requested: refund',
      refs: [`${prefix}-run-1`],
    });
    await recordActivity(database, {
      at: '2099-01-09T10:00:00Z',
      actor: `${prefix}-alice`,
      kind: 'run',
      subject: `${prefix}-run-2`,
      summary: 'run FAILED: import',
    });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM activity_events WHERE actor LIKE $1`, [`${prefix}%`]);
    await database.close();
  });

  it('filters by time, kind, actor and text', async () => {
    const base: ActivityQuery = {
      timeRange: { from: '2099-01-10T00:00:00Z', to: '2099-01-11T00:00:00Z' },
    };
    const all = await queryActivity(database, base);
    expect(all.map((row) => row.subject)).toEqual([`${prefix}-approval-1`, `${prefix}-run-1`]);
    expect((await queryActivity(database, { ...base, kinds: ['approval'] })).length).toBe(1);
    expect((await queryActivity(database, { ...base, actors: [`${prefix}-alice`] })).length).toBe(
      1,
    );
    expect((await queryActivity(database, { ...base, text: 'billing' })).length).toBe(1);
    expect((await queryActivity(database, { ...base, agentIds: [`${prefix}-run-1`] })).length).toBe(
      2,
    );
  });

  it('is failure-tolerant when the table is unavailable', async () => {
    const broken = {
      query: async () => {
        throw new Error('database down');
      },
    } as unknown as Database;
    await expect(
      recordActivity(broken, {
        kind: 'run',
        subject: 'x',
        summary: 'x',
      }),
    ).resolves.toBe(false);
  });
});

describeIfDb('activity write hooks (phase 18.6)', () => {
  it('records run, approval, tool and audit-driven activity', async () => {
    const database = new PostgresDatabase(DATABASE_URL);
    const approvalId = ulid();
    let startedRunId = '';
    const moduleId = `activity-hook-${ulid().toLowerCase()}`;
    const demo: TriageModule = {
      id: moduleId,
      version: '0.1.0',
      capabilities: [],
      dependsOn: { capabilities: [] },
      manifest: { routes: [], nav: [], background: [] },
      lifecycle: {},
      register(context: KernelContext) {
        context.registerStageHandler('activity-hook.noop', {
          execute: async () => ({
            output: { ok: true },
            evidence: { kind: 'deterministic' as const, values: {} },
            deterministic: {},
          }),
        });
        context.queue.start({
          id: `${moduleId}.wf`,
          module: moduleId,
          version: '0.1.0',
          trigger: { type: 'manual' },
          stages: [{ id: 'one', kind: 'activity-hook.noop' }],
        });
      },
    };
    const kernel = await bootKernel({
      config: {
        profile: 'core',
        queue: { adapter: 'inline', pollIntervalMs: 10 },
        modules: { [moduleId]: { enabled: true } },
        capabilities: {},
      },
      database,
      logger,
      modules: { [moduleId]: demo },
    });
    try {
      const started = await kernel.workflowEngine.start(`${moduleId}.wf`, {});
      startedRunId = started.runId;
      await kernel.queue.enqueue(
        'workflow.run',
        { runId: started.runId },
        { idempotencyKey: `run:${started.runId}` },
      );
      const deadline = Date.now() + 10_000;
      for (;;) {
        const rows = await database.query<{ status: string }>(
          `SELECT status FROM workflow_runs WHERE id = $1`,
          [started.runId],
        );
        if (rows[0]?.status === 'SUCCEEDED' || Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const runs = await database.query<{ kind: string; summary: string }>(
        `SELECT kind, summary FROM activity_events WHERE subject = $1 ORDER BY at, id`,
        [started.runId],
      );
      expect(runs.map((row) => row.kind)).toEqual(['run', 'run']);
      expect(runs.map((row) => row.summary).join(' ')).toContain('started');
      expect(runs.map((row) => row.summary).join(' ')).toContain('SUCCEEDED');

      await database.query(
        `INSERT INTO approvals (id, run_id, step_id, tool_name, input, status, expires_at)
         VALUES ($1, $2, 'step', 'refund', '{}'::jsonb, 'pending', now() + interval '1 hour')`,
        [approvalId, started.runId],
      );
      await database.query(
        `UPDATE approvals SET status = 'approved', approver = 'admin@test.dev', decided_at = now()
          WHERE id = $1`,
        [approvalId],
      );
      const approvals = await database.query<{ summary: string }>(
        `SELECT summary FROM activity_events WHERE kind = 'approval' AND subject = $1 ORDER BY at, id`,
        [approvalId],
      );
      expect(approvals.map((row) => row.summary).join(' ')).toContain('requested');
      expect(approvals.map((row) => row.summary).join(' ')).toContain('approved');

      await database.query(
        `INSERT INTO stage_runs (id, run_id, stage_id, kind, status)
         VALUES ($1, $2, 'tool-step', 'tool', 'FAILED')`,
        [ulid(), started.runId],
      );
      const tools = await database.query<{ summary: string }>(
        `SELECT summary FROM activity_events WHERE kind = 'tool' AND subject = $1`,
        [started.runId],
      );
      expect(tools.some((row) => row.summary.includes('failed'))).toBe(true);

      await database.query(
        `INSERT INTO audit_events (id, actor, action, subject, payload)
         VALUES ($1, 'admin@test.dev', 'config.updated', 'activity-test', '{}'::jsonb)`,
        [ulid()],
      );
      await database.query(
        `INSERT INTO audit_events (id, actor, action, subject, payload)
         VALUES ($1, 'system', 'alert.fired', 'activity-test', '{}'::jsonb)`,
        [ulid()],
      );
      const audited = await database.query<{ kind: string }>(
        `SELECT kind FROM activity_events WHERE subject = 'activity-test' ORDER BY kind`,
      );
      expect(audited.map((row) => row.kind)).toEqual(['alert', 'config']);
    } finally {
      await database.query(`DELETE FROM activity_events WHERE subject = ANY($1::text[])`, [
        [startedRunId, approvalId, 'activity-test'],
      ]);
      await database.query(`DELETE FROM workflow_runs WHERE id = $1`, [startedRunId]);
      await database.query(`DELETE FROM approvals WHERE id = $1`, [approvalId]);
      await kernel.shutdown();
      await database.close();
    }
  }, 30_000);
});
