import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError, dependencyUnavailable } from '../src/errors.js';
import type { WorkflowGraph } from '../src/graph/v2.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type {
  ChatModel,
  ChatRequest,
  ChatResponse,
  KernelLogger,
  QueueCapability,
  WorkflowDef,
} from '../src/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { WorkflowEngine } from '../src/workflow.js';
import type { WorkflowEngineDeps } from '../src/workflow.js';

const noopLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withEngine(
  fn: (engine: WorkflowEngine, database: PostgresDatabase) => Promise<void>,
  opts: { deps?: WorkflowEngineDeps; queue?: QueueCapability } = {},
): Promise<void> {
  const database = new PostgresDatabase(DATABASE_URL);
  await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
  const engine = new WorkflowEngine(database, noopLogger, undefined, opts.queue, {}, opts.deps);
  try {
    await fn(engine, database);
  } finally {
    await database.close();
  }
}

type GraphBody = Omit<WorkflowGraph, 'id' | 'version' | 'module' | 'trigger'> & {
  trigger?: WorkflowGraph['trigger'];
};

function graphDef(id: string, body: GraphBody, extra: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    id,
    version: '0.1.0',
    module: 'test',
    trigger: { type: 'endpoint' },
    stages: [],
    graph: { id, version: '0.1.0', module: 'test', trigger: { type: 'endpoint' }, ...body },
    ...extra,
  };
}

async function cleanup(database: PostgresDatabase, workflowId: string): Promise<void> {
  await database.query(
    `DELETE FROM approvals WHERE run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = $1)`,
    [workflowId],
  );
  await database.query(`DELETE FROM workflow_runs WHERE workflow_id = $1`, [workflowId]);
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
    kind: string;
    status: string;
    attempts: number;
    output: Record<string, unknown> | null;
  }>(
    `SELECT stage_id, kind, status, attempts, output FROM stage_runs WHERE run_id = $1 ORDER BY created_at, stage_id`,
    [runId],
  );
}

async function hopsOf(database: PostgresDatabase, runId: string) {
  return database.query<{
    evidence: Record<string, unknown> | null;
    deterministic: Record<string, unknown> | null;
  }>(
    `SELECT evidence, deterministic FROM decision_records
     WHERE run_id = $1 AND (outcome->>'transition') = 'true' ORDER BY created_at`,
    [runId],
  );
}

async function decisionsOf(database: PostgresDatabase, runId: string) {
  return database.query<{
    evidence: Record<string, unknown> | null;
    deterministic: Record<string, unknown> | null;
    model_output: Record<string, unknown> | null;
    outcome: Record<string, unknown> | null;
    error: Record<string, unknown> | null;
  }>(
    `SELECT evidence, deterministic, model_output, outcome, error FROM decision_records WHERE run_id = $1 ORDER BY created_at`,
    [runId],
  );
}

function expectRegisterProblems(engine: WorkflowEngine, def: WorkflowDef): string[] {
  try {
    engine.register(def, 'test', '0.1.0');
  } catch (err) {
    expect((err as AppError).code).toBe('kernel.WORKFLOW_INVALID');
    expect((err as AppError).category).toBe('validation');
    return (err as AppError).details as string[];
  }
  throw new Error('expected registration to fail');
}

function fakeModel(content: string): ChatModel {
  return {
    async chat(request: ChatRequest): Promise<ChatResponse> {
      void request;
      return {
        message: { role: 'assistant', content },
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end',
        modelVersion: 'fake-1',
      };
    },
    describe: () => ({
      provider: 'fake',
      model: 'fake-model',
      hosted: false,
      contextWindow: 1_000,
      maxOutput: 100,
      supportsTools: false,
      supportsStreaming: false,
    }),
  };
}

function makeTool(
  name: string,
  handler: (input: Record<string, unknown>) => Promise<unknown>,
): ToolDefinition<unknown, unknown> {
  return {
    name,
    version: '1.0.0',
    owner: 'test',
    description: 'A test tool used by the graph executor tests.',
    examples: [{ value: 1 }],
    input: z.unknown(),
    output: z.unknown(),
    access: 'read',
    risk: 'low',
    scopes: ['test.read'],
    egressClass: 'internal',
    idempotent: true,
    timeoutMs: 1_000,
    undo: 'free',
    retry: { maxAttempts: 0, backoff: 'none', retryOn: [] },
    handler: async (input) => handler((input ?? {}) as Record<string, unknown>),
  };
}

describeIfDb('workflow graph v2 execution (phase 18.3)', () => {
  it('rejects invalid graphs at register with kernel.WORKFLOW_INVALID', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.echo', {
        execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
      });
      const base: GraphBody = {
        start: 'a',
        nodes: [
          { id: 'a', type: 'stage', kind: 't.echo' },
          { id: 'end', type: 'end', end: 'succeeded' },
        ],
        edges: [{ from: 'a', to: 'end', label: 'next' }],
        defaultErrorEdge: { to: 'end' },
        budget: { maxSteps: 10, maxDurationMs: 300_000 },
      };
      expect(
        expectRegisterProblems(
          engine,
          graphDef('test.graph.unreachable', {
            ...base,
            nodes: [...base.nodes, { id: 'orphan', type: 'stage', kind: 't.echo' }],
          }),
        ),
      ).toContain('node orphan is unreachable');

      expect(
        expectRegisterProblems(engine, {
          ...graphDef('test.graph.no-default', {
            ...base,
            nodes: [
              { id: 'a', type: 'branch' },
              { id: 'end', type: 'end', end: 'succeeded' },
            ],
            edges: [{ from: 'a', to: 'end', label: 'yes' }],
          }),
        }),
      ).toContain('branch a needs a default edge');

      expect(
        expectRegisterProblems(
          engine,
          graphDef('test.graph.no-max', {
            ...base,
            nodes: [
              { id: 'a', type: 'loop' },
              { id: 'end', type: 'end', end: 'succeeded' },
            ],
            edges: [{ from: 'a', to: 'end', label: 'next' }],
          }),
        ),
      ).toContain('loop a needs maxIterations');

      expect(
        expectRegisterProblems(
          engine,
          graphDef('test.graph.no-reason', {
            ...base,
            nodes: [
              { id: 'a', type: 'agent_step', kind: 't.step', labels: ['done'] },
              { id: 'end', type: 'end', end: 'succeeded' },
            ],
            edges: [{ from: 'a', to: 'end', label: 'done' }],
          }),
        ),
      ).toContain('rung 3+ needs an executionStyleReason');

      // rung 4 + a reason passes the ladder and the loop cap rule is satisfied
      expect(() =>
        engine.register(
          graphDef('test.graph.agent-ok', {
            ...base,
            nodes: [
              { id: 'a', type: 'agent_step', kind: 't.step', labels: ['done'] },
              { id: 'end', type: 'end', end: 'succeeded' },
            ],
            edges: [{ from: 'a', to: 'end', label: 'done' }],
            executionStyleReason: 'bounded investigation across tools',
          }),
          'test',
          '0.1.0',
        ),
      ).not.toThrow();

      expect(
        expectRegisterProblems(
          engine,
          graphDef('test.graph.no-probe', {
            ...base,
            trigger: { type: 'schedule', config: { intervalMinutes: 15 } },
            nodes: [
              {
                id: 'a',
                type: 'llm_decision',
                input: { value: '$.flag' },
              },
              { id: 'end', type: 'end', end: 'succeeded' },
            ],
            edges: [
              { from: 'a', to: 'end', label: 'go' },
              { from: 'a', to: 'end', label: 'default', isDefault: true },
            ],
            executionStyleReason: 'one bounded model choice per wake-up',
          }),
        ),
      ).toContain('sub-hourly model-calling schedules require a probe');

      // with a declared probe the same graph loads
      expect(() =>
        engine.register(
          graphDef('test.graph.probe-ok', {
            ...base,
            trigger: {
              type: 'schedule',
              config: { intervalMinutes: 15 },
              schedule: {
                cron: '*/15 * * * *',
                probe: { kind: 'watermark', read: 'max_updated_at' },
                overlap: 'skip',
                silentWhenEmpty: true,
              },
            },
            nodes: [
              { id: 'a', type: 'llm_decision' },
              { id: 'end', type: 'end', end: 'succeeded' },
            ],
            edges: [
              { from: 'a', to: 'end', label: 'go' },
              { from: 'a', to: 'end', label: 'default', isDefault: true },
            ],
            executionStyleReason: 'one bounded model choice per wake-up',
          }),
          'test',
          '0.1.0',
        ),
      ).not.toThrow();
      void database;
    });
  });

  it('runs stage→branch→stage→end and records every hop with guards', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.echo', {
        execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
      });
      engine.register(
        graphDef('test.graph.happy', {
          start: 's1',
          nodes: [
            { id: 's1', type: 'stage', kind: 't.echo', input: { value: '$.flag' } },
            { id: 'b', type: 'branch' },
            { id: 's2', type: 'stage', kind: 't.echo', input: { value: 'from-branch' } },
            { id: 'end', type: 'end', end: 'succeeded' },
          ],
          edges: [
            { from: 's1', to: 'b', label: 'next' },
            { from: 'b', to: 's2', label: 'yes', when: "${stages.s1.output.value} == 'yes'" },
            { from: 'b', to: 'end', label: 'no', isDefault: true },
            { from: 's2', to: 'end', label: 'next' },
          ],
          defaultErrorEdge: { to: 'end' },
          budget: { maxSteps: 10, maxDurationMs: 300_000 },
        }),
        'test',
        '0.1.0',
      );
      await cleanup(database, 'test.graph.happy');

      const { runId } = await engine.start('test.graph.happy', { flag: 'yes' });
      await engine.processRun(runId);

      expect((await runOf(database, runId)).status).toBe('SUCCEEDED');
      const stages = await stagesOf(database, runId);
      expect(stages.map((s) => [s.stage_id, s.status])).toEqual([
        ['s1', 'SUCCEEDED'],
        ['b', 'SUCCEEDED'],
        ['s2', 'SUCCEEDED'],
        ['end', 'SUCCEEDED'],
      ]);
      const hops = await hopsOf(database, runId);
      expect(
        hops.map((hop) => [hop.evidence?.from, hop.evidence?.to, hop.evidence?.label]),
      ).toEqual([
        ['s1', 'b', 'next'],
        ['b', 's2', 'yes'],
        ['s2', 'end', 'next'],
      ]);
      // the branch hop carries the evaluated guard values
      expect(hops[1]?.deterministic).toMatchObject({ guards: { yes: true } });

      // the default edge is taken when no guard passes
      const { runId: defaultRun } = await engine.start('test.graph.happy', { flag: 'no' });
      await engine.processRun(defaultRun);
      expect((await runOf(database, defaultRun)).status).toBe('SUCCEEDED');
      const defaultHops = await hopsOf(database, defaultRun);
      expect(defaultHops.map((hop) => hop.evidence?.label)).toEqual(['next', 'no']);
      const defaultStages = await stagesOf(database, defaultRun);
      expect(defaultStages.map((s) => s.stage_id)).toEqual(['s1', 'b', 'end']);
    });
  });

  it('takes the declared llm_decision choice, and the default edge when the model output is invalid', async () => {
    let modelContent = '{"choice":"go","reason":"flag is yes"}';
    await withEngine(
      async (engine, database) => {
        engine.registerStageHandler('t.echo', {
          execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
        });
        const body: GraphBody = {
          start: 'ask',
          nodes: [
            { id: 'ask', type: 'llm_decision', input: { value: '$.flag' } },
            { id: 'fast', type: 'stage', kind: 't.echo', input: { value: 'fast' } },
            { id: 'end', type: 'end', end: 'succeeded' },
          ],
          edges: [
            { from: 'ask', to: 'fast', label: 'go' },
            { from: 'ask', to: 'end', label: 'default', isDefault: true },
            { from: 'fast', to: 'end', label: 'next' },
          ],
          defaultErrorEdge: { to: 'end' },
          budget: { maxSteps: 10, maxDurationMs: 300_000 },
          executionStyleReason: 'one bounded model choice between declared routes',
        };
        engine.register(graphDef('test.graph.llm', body), 'test', '0.1.0');
        await cleanup(database, 'test.graph.llm');

        // declared choice taken + recorded
        const good = await engine.start('test.graph.llm', { flag: 'yes' });
        await engine.processRun(good.runId);
        expect((await runOf(database, good.runId)).status).toBe('SUCCEEDED');
        expect((await stagesOf(database, good.runId)).map((s) => s.stage_id)).toEqual([
          'ask',
          'fast',
          'end',
        ]);
        const goodDecisions = await decisionsOf(database, good.runId);
        const choiceRow = goodDecisions.find((row) => row.evidence?.choice === 'go');
        expect(choiceRow).toBeDefined();
        expect(choiceRow?.evidence).toMatchObject({ choice: 'go', reason: 'flag is yes' });
        expect(choiceRow?.model_output).toMatchObject({ choice: 'go', model: 'fake-model' });

        // malformed output → default edge recorded, run continues
        modelContent = 'not json at all';
        const bad = await engine.start('test.graph.llm', { flag: 'no' });
        await engine.processRun(bad.runId);
        expect((await runOf(database, bad.runId)).status).toBe('SUCCEEDED');
        const badStages = await stagesOf(database, bad.runId);
        expect(badStages.map((s) => s.stage_id)).toEqual(['ask', 'end']);
        const badHops = await hopsOf(database, bad.runId);
        expect(badHops[0]?.evidence).toMatchObject({ usedDefault: true });
        const badDecisions = await decisionsOf(database, bad.runId);
        expect(
          badDecisions.some((row) => row.outcome?.usedDefault === true && row.outcome?.reason),
        ).toBe(true);
      },
      { deps: { chatModel: () => fakeModel(modelContent) } },
    );
  });

  it('parks a write tool for approval and executes it after approval', async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    const base = makeTool('test.send_thing', async () => {
      calls += 1;
      return { sent: true };
    });
    registry.register({
      ...base,
      access: 'write',
      risk: 'high',
      undo: 'none',
      scopes: ['test.write'],
      preview: async () => ({ summary: 'send one thing', affects: [] }),
    });
    await withEngine(
      async (engine, database) => {
        engine.register(
          graphDef('test.graph.tool-approval', {
            start: 'send',
            nodes: [
              { id: 'send', type: 'tool', tool: 'test.send_thing' },
              { id: 'end', type: 'end', end: 'succeeded' },
              { id: 'failed', type: 'end', end: 'failed' },
            ],
            edges: [{ from: 'send', to: 'end', label: 'next' }],
            defaultErrorEdge: { to: 'failed' },
            budget: { maxSteps: 10, maxDurationMs: 300_000 },
          }),
          'test',
          '0.1.0',
        );
        await cleanup(database, 'test.graph.tool-approval');
        const { runId } = await engine.start('test.graph.tool-approval', {});
        await engine.processRun(runId);
        expect((await runOf(database, runId)).status).toBe('AWAITING');
        expect(calls).toBe(0);
        const approvals = await database.query<{ id: string }>(
          `SELECT id FROM approvals WHERE run_id = $1`,
          [runId],
        );
        expect(approvals[0]?.id).toBeDefined();
        const resumed = await engine.resolveApproval(runId, approvals[0]!.id, 'approved', {
          approver: 'tester',
        });
        expect(resumed.resumed).toBe(true);
        expect(calls).toBe(1);
        expect((await runOf(database, runId)).status).toBe('SUCCEEDED');
      },
      { deps: { toolRegistry: () => registry } },
    );
  });

  it('routes tool failures along declared error edges and the graph default', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('test.get_thing', async () => ({ ok: true })));
    registry.register(
      makeTool('test.run_fail', async () => {
        throw new Error('boom');
      }),
    );
    await withEngine(
      async (engine, database) => {
        engine.registerStageHandler('t.echo', {
          execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
        });
        engine.register(
          graphDef('test.graph.tool-error', {
            start: 'work',
            nodes: [
              { id: 'work', type: 'tool', tool: 'test.run_fail' },
              { id: 'recover', type: 'stage', kind: 't.echo', input: { value: 'recovered' } },
              { id: 'end', type: 'end', end: 'succeeded' },
            ],
            edges: [
              { from: 'work', to: 'end', label: 'next' },
              { from: 'work', to: 'recover', label: 'error', on: ['internal'] },
              { from: 'recover', to: 'end', label: 'next' },
            ],
            defaultErrorEdge: { to: 'end' },
            budget: { maxSteps: 10, maxDurationMs: 300_000 },
          }),
          'test',
          '0.1.0',
        );
        await cleanup(database, 'test.graph.tool-error');
        const { runId } = await engine.start('test.graph.tool-error', {});
        await engine.processRun(runId);
        expect((await runOf(database, runId)).status).toBe('SUCCEEDED');
        const hops = await hopsOf(database, runId);
        expect(
          hops.map((hop) => [hop.evidence?.from, hop.evidence?.label, hop.evidence?.onCategory]),
        ).toEqual([
          ['work', 'error', 'internal'],
          ['recover', 'next', undefined],
        ]);

        // without a matching error edge the graph default applies
        engine.register(
          graphDef('test.graph.tool-default', {
            start: 'work',
            nodes: [
              { id: 'work', type: 'tool', tool: 'test.run_fail' },
              { id: 'end', type: 'end', end: 'succeeded' },
              { id: 'failed', type: 'end', end: 'failed' },
            ],
            edges: [{ from: 'work', to: 'end', label: 'next' }],
            defaultErrorEdge: { to: 'failed' },
            budget: { maxSteps: 10, maxDurationMs: 300_000 },
          }),
          'test',
          '0.1.0',
        );
        await cleanup(database, 'test.graph.tool-default');
        const bad = await engine.start('test.graph.tool-default', {});
        await engine.processRun(bad.runId);
        expect((await runOf(database, bad.runId)).status).toBe('FAILED');
        // The original structured failure is preserved, not replaced by a
        // generic "graph ended" message.
        expect((await runOf(database, bad.runId)).error).toContain('boom');
        const hops2 = await hopsOf(database, bad.runId);
        expect(hops2[0]?.evidence).toMatchObject({
          from: 'work',
          label: 'error',
          onCategory: 'internal',
          defaultErrorEdge: true,
        });
      },
      { deps: { toolRegistry: () => registry } },
    );
  });

  it('runs parallel branches to a join(all), maps items with capped parallelism and loops to maxIterations', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.echo', {
        execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
      });
      let active = 0;
      let maxActive = 0;
      engine.registerStageHandler('t.slow_echo', {
        execute: async (stage) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(30);
          active -= 1;
          return { output: { value: stage.input.value } };
        },
      });

      engine.register(
        graphDef('test.graph.parallel', {
          start: 'p',
          nodes: [
            { id: 'p', type: 'parallel', config: { maxParallel: 2 } },
            { id: 'b1', type: 'stage', kind: 't.echo', input: { value: 'b1' } },
            { id: 'b2', type: 'stage', kind: 't.echo', input: { value: 'b2' } },
            { id: 'j', type: 'join', join: { mode: 'all', branchTimeoutMs: 5_000 } },
            { id: 'end', type: 'end', end: 'succeeded' },
          ],
          edges: [
            { from: 'p', to: 'b1', label: 'branch' },
            { from: 'p', to: 'b2', label: 'branch' },
            { from: 'b1', to: 'j', label: 'next' },
            { from: 'b2', to: 'j', label: 'next' },
            { from: 'j', to: 'end', label: 'next' },
          ],
          defaultErrorEdge: { to: 'end' },
          budget: { maxSteps: 20, maxDurationMs: 300_000 },
        }),
        'test',
        '0.1.0',
      );
      await cleanup(database, 'test.graph.parallel');
      const parallelRun = await engine.start('test.graph.parallel', {});
      await engine.processRun(parallelRun.runId);
      expect((await runOf(database, parallelRun.runId)).status).toBe('SUCCEEDED');
      const parallelStages = await stagesOf(database, parallelRun.runId);
      expect(parallelStages.filter((s) => s.stage_id === 'b1' || s.stage_id === 'b2')).toHaveLength(
        2,
      );
      const joinRow = parallelStages.find((s) => s.stage_id === 'j');
      expect(joinRow?.output).toMatchObject({ joined: 2, mode: 'all' });

      engine.register(
        graphDef('test.graph.map', {
          start: 'm',
          nodes: [
            { id: 'm', type: 'map', map: { items: '$.items', maxParallel: 2 } },
            { id: 'w', type: 'stage', kind: 't.slow_echo', input: { value: '${item}' } },
            { id: 'j2', type: 'join', join: { mode: 'all', branchTimeoutMs: 5_000 } },
            { id: 'end', type: 'end', end: 'succeeded' },
          ],
          edges: [
            { from: 'm', to: 'w', label: 'body' },
            { from: 'w', to: 'j2', label: 'next' },
            { from: 'j2', to: 'end', label: 'next' },
          ],
          defaultErrorEdge: { to: 'end' },
          budget: { maxSteps: 20, maxDurationMs: 300_000 },
        }),
        'test',
        '0.1.0',
      );
      await cleanup(database, 'test.graph.map');
      const mapRun = await engine.start('test.graph.map', { items: ['a', 'b', 'c'] });
      await engine.processRun(mapRun.runId);
      expect((await runOf(database, mapRun.runId)).status).toBe('SUCCEEDED');
      const mapStages = await stagesOf(database, mapRun.runId);
      const itemRows = mapStages.filter((s) => s.stage_id === 'w');
      expect(itemRows).toHaveLength(3);
      expect(new Set(itemRows.map((s) => s.output?.value))).toEqual(new Set(['a', 'b', 'c']));
      expect(maxActive).toBe(2); // capped at maxParallel, never 3

      let calls = 0;
      engine.registerStageHandler('t.count', {
        execute: async () => {
          calls += 1;
          return { output: { call: calls } };
        },
      });
      engine.register(
        graphDef('test.graph.loop', {
          start: 'l',
          nodes: [
            { id: 'l', type: 'loop', loop: { maxIterations: 3, while: 'true' } },
            { id: 's', type: 'stage', kind: 't.count' },
            { id: 'end', type: 'end', end: 'succeeded' },
          ],
          edges: [
            { from: 'l', to: 's', label: 'again' },
            { from: 's', to: 'l', label: 'next' },
            { from: 'l', to: 'end', label: 'done' },
          ],
          defaultErrorEdge: { to: 'end' },
          budget: { maxSteps: 20, maxDurationMs: 300_000 },
        }),
        'test',
        '0.1.0',
      );
      await cleanup(database, 'test.graph.loop');
      const loopRun = await engine.start('test.graph.loop', {});
      await engine.processRun(loopRun.runId);
      expect(calls).toBe(3);
      expect((await runOf(database, loopRun.runId)).status).toBe('SUCCEEDED');
      const loopHops = await hopsOf(database, loopRun.runId);
      expect(loopHops.filter((hop) => hop.evidence?.loopIteration)).toHaveLength(3);
      expect(loopHops.at(-1)?.evidence).toMatchObject({ loopExited: true });
    });
  });

  it('starts a subworkflow and observes its terminal status (wait: true)', async () => {
    let engineRef: WorkflowEngine | undefined;
    const queue: QueueCapability = {
      start: () => undefined,
      startWorkflow: async (workflowId, input, opts) => {
        const current = engineRef;
        if (!current) throw new Error('engine not ready');
        const started = await current.start(workflowId, input, opts);
        if (!started.deduped) await current.processRun(started.runId);
        return started;
      },
      registerWorker: () => undefined,
      drain: async () => undefined,
    };
    await withEngine(
      async (engine, database) => {
        engineRef = engine;
        engine.registerStageHandler('t.echo', {
          execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
        });
        engine.register(
          {
            id: 'test.graph.child',
            version: '0.1.0',
            module: 'test',
            trigger: { type: 'endpoint' },
            stages: [{ id: 'work', kind: 't.echo', input: { value: '$.text' } }],
          },
          'test',
          '0.1.0',
        );
        engine.register(
          graphDef('test.graph.parent', {
            start: 'sub',
            nodes: [
              {
                id: 'sub',
                type: 'subworkflow',
                workflow: { id: 'test.graph.child', versionRange: '^0.1.0', wait: true },
              },
              { id: 'end', type: 'end', end: 'succeeded' },
            ],
            edges: [{ from: 'sub', to: 'end', label: 'next' }],
            defaultErrorEdge: { to: 'end' },
            budget: { maxSteps: 10, maxDurationMs: 300_000 },
          }),
          'test',
          '0.1.0',
        );
        await cleanup(database, 'test.graph.parent');
        await cleanup(database, 'test.graph.child');

        const { runId } = await engine.start('test.graph.parent', { text: 'hi' });
        await engine.processRun(runId);

        expect((await runOf(database, runId)).status).toBe('SUCCEEDED');
        const childRuns = await database.query<{ id: string; status: string }>(
          `SELECT id, status FROM workflow_runs WHERE workflow_id = 'test.graph.child'`,
        );
        expect(childRuns).toHaveLength(1);
        expect(childRuns[0]?.status).toBe('SUCCEEDED');
        const hops = await hopsOf(database, runId);
        expect(hops[0]?.evidence).toMatchObject({ from: 'sub', to: 'end', label: 'next' });
      },
      { queue },
    );
  });

  it('parks on approval, is a no-op on redelivery and resumes via resolveApproval', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.echo', {
        execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
      });
      engine.register(
        graphDef('test.graph.approval', {
          start: 's1',
          nodes: [
            { id: 's1', type: 'stage', kind: 't.echo', input: { value: 'before' } },
            {
              id: 'ap',
              type: 'approval',
              approval: { approvers: ['admin'], expiresAfterMs: 60_000 },
              input: { action: 'send_report' },
            },
            { id: 's2', type: 'stage', kind: 't.echo', input: { value: 'after' } },
            { id: 'end', type: 'end', end: 'succeeded' },
            { id: 'endFailed', type: 'end', end: 'failed' },
          ],
          edges: [
            { from: 's1', to: 'ap', label: 'next' },
            { from: 'ap', to: 's2', label: 'approved' },
            { from: 'ap', to: 'endFailed', label: 'rejected' },
            { from: 's2', to: 'end', label: 'next' },
          ],
          defaultErrorEdge: { to: 'endFailed' },
          budget: { maxSteps: 10, maxDurationMs: 300_000 },
        }),
        'test',
        '0.1.0',
      );
      await cleanup(database, 'test.graph.approval');

      const { runId } = await engine.start('test.graph.approval', {});
      await engine.processRun(runId);

      expect((await runOf(database, runId)).status).toBe('AWAITING');
      const approvals = await database.query<{ id: string; step_id: string; status: string }>(
        `SELECT id, step_id, status FROM approvals WHERE run_id = $1 ORDER BY created_at`,
        [runId],
      );
      expect(approvals).toHaveLength(1);
      expect(approvals[0]).toMatchObject({ step_id: 'ap', status: 'pending' });
      const parkedDecisions = await decisionsOf(database, runId);
      expect(parkedDecisions.some((row) => row.evidence?.approval === approvals[0]?.id)).toBe(true);
      const before = (await stagesOf(database, runId)).map((s) => [s.stage_id, s.status]);

      // redelivery while AWAITING is an idempotent no-op
      await engine.processRun(runId);
      expect((await runOf(database, runId)).status).toBe('AWAITING');
      expect((await stagesOf(database, runId)).map((s) => [s.stage_id, s.status])).toEqual(before);

      const resolved = await engine.resolveApproval(runId, approvals[0]!.id, 'approved');
      expect(resolved.resumed).toBe(true);
      expect((await runOf(database, runId)).status).toBe('SUCCEEDED');
      const after = await stagesOf(database, runId);
      expect(after.map((s) => [s.stage_id, s.status])).toEqual([
        ['s1', 'SUCCEEDED'],
        ['ap', 'SUCCEEDED'],
        ['s2', 'SUCCEEDED'],
        ['end', 'SUCCEEDED'],
      ]);
      const hops = await hopsOf(database, runId);
      expect(hops.find((hop) => hop.evidence?.label === 'approved')?.evidence).toMatchObject({
        from: 'ap',
        to: 's2',
        approvalId: approvals[0]!.id,
      });

      // resolving twice is a no-op (run already terminal)
      const repeat = await engine.resolveApproval(runId, approvals[0]!.id, 'approved');
      expect(repeat.resumed).toBe(false);
    });
  });

  it('maps an escalated end outcome to AWAITING and records it', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.echo', {
        execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
      });
      engine.register(
        graphDef('test.graph.escalate', {
          start: 's1',
          nodes: [
            { id: 's1', type: 'stage', kind: 't.echo' },
            { id: 'end', type: 'end', end: 'escalated' },
          ],
          edges: [{ from: 's1', to: 'end', label: 'next' }],
          defaultErrorEdge: { to: 'end' },
          budget: { maxSteps: 10, maxDurationMs: 300_000 },
        }),
        'test',
        '0.1.0',
      );
      await cleanup(database, 'test.graph.escalate');
      const { runId } = await engine.start('test.graph.escalate', {});
      await engine.processRun(runId);
      expect((await runOf(database, runId)).status).toBe('AWAITING');
      const decisions = await decisionsOf(database, runId);
      const endRow = decisions.at(-1);
      expect(endRow?.evidence).toMatchObject({ end: 'end', outcome: 'escalated' });
      // redelivery stays a no-op
      await engine.processRun(runId);
      expect((await runOf(database, runId)).status).toBe('AWAITING');
    });
  });

  it('records the v1 fallback policy on a stage error hop and derives the end outcome from it', async () => {
    await withEngine(async (engine, database) => {
      let attempts = 0;
      engine.registerStageHandler('t.flaky', {
        execute: async () => {
          attempts += 1;
          throw dependencyUnavailable('llm timeout');
        },
      });
      const def = (id: string) =>
        graphDef(
          id,
          {
            start: 'generate',
            nodes: [
              {
                id: 'generate',
                type: 'stage',
                kind: 't.flaky',
                retry: { attempts: 2, backoffMs: [1] },
              },
              { id: 'end', type: 'end', end: 'succeeded' },
              { id: 'escalated', type: 'end', end: 'escalated' },
              { id: 'failed', type: 'end', end: 'failed' },
            ],
            edges: [
              { from: 'generate', to: 'end', label: 'next' },
              {
                from: 'generate',
                to: 'escalated',
                label: 'fallback',
                on: ['dependency_unavailable'],
              },
            ],
            defaultErrorEdge: { to: 'failed' },
            budget: { maxSteps: 10, maxDurationMs: 300_000 },
          },
          { fallbackPolicyId: 'escalate_human' },
        );

      engine.register(def('test.graph.fallback'), 'test', '0.1.0');
      await cleanup(database, 'test.graph.fallback');
      const awaiting = await engine.start('test.graph.fallback', {});
      await engine.processRun(awaiting.runId);
      expect(attempts).toBe(2);
      expect((await runOf(database, awaiting.runId)).status).toBe('AWAITING');
      // The original error text stays on the run so module subscribers can act.
      expect((await runOf(database, awaiting.runId)).error).toContain('llm timeout');
      const hops = await database.query<{ fallback: unknown; evidence: Record<string, unknown> }>(
        `SELECT fallback, evidence FROM decision_records
         WHERE run_id = $1 AND fallback IS NOT NULL ORDER BY created_at`,
        [awaiting.runId],
      );
      expect(hops).toHaveLength(1);
      expect(hops[0]?.evidence).toMatchObject({ from: 'generate', label: 'fallback' });
      expect(hops[0]?.fallback).toMatchObject({
        policyApplied: 'escalate_human',
        action: 'awaiting',
        stageId: 'generate',
        error: 'llm timeout',
        attempts: 2,
      });

      // halt_run keeps v1's FAILED terminal state even on an `escalated` end.
      engine.register(
        { ...def('test.graph.fallback-halt'), fallbackPolicyId: 'halt_run' },
        'test',
        '0.1.0',
      );
      await cleanup(database, 'test.graph.fallback-halt');
      const halted = await engine.start('test.graph.fallback-halt', {});
      await engine.processRun(halted.runId);
      expect((await runOf(database, halted.runId)).status).toBe('FAILED');
      const haltHops = await database.query<{ fallback: unknown }>(
        `SELECT fallback FROM decision_records WHERE run_id = $1 AND fallback IS NOT NULL`,
        [halted.runId],
      );
      expect(haltHops[0]?.fallback).toMatchObject({ policyApplied: 'halt_run', action: 'fail' });
    });
  });

  it('runs declared compensation when a later node fails, then follows the default error edge', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('test.get_thing', async () => ({ undone: true })));
    registry.register(
      makeTool('test.run_fail', async () => {
        throw new Error('boom');
      }),
    );
    await withEngine(
      async (engine, database) => {
        engine.registerStageHandler('t.echo', {
          execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
        });
        engine.register(
          graphDef('test.graph.compensate', {
            start: 'writer',
            nodes: [
              { id: 'writer', type: 'tool', tool: 'test.get_thing' },
              { id: 'after', type: 'stage', kind: 't.echo', input: { value: 'after' } },
              { id: 'boom', type: 'tool', tool: 'test.run_fail' },
              { id: 'fixup', type: 'tool', tool: 'test.get_thing' },
              { id: 'end', type: 'end', end: 'succeeded' },
              { id: 'endFailed', type: 'end', end: 'failed' },
            ],
            edges: [
              { from: 'writer', to: 'after', label: 'next' },
              { from: 'writer', to: 'fixup', label: 'undo', compensate: true },
              { from: 'fixup', to: 'end', label: 'next' },
              { from: 'after', to: 'boom', label: 'next' },
              { from: 'boom', to: 'end', label: 'next' },
            ],
            defaultErrorEdge: { to: 'endFailed' },
            budget: { maxSteps: 20, maxDurationMs: 300_000 },
          }),
          'test',
          '0.1.0',
        );
        await cleanup(database, 'test.graph.compensate');
        const { runId } = await engine.start('test.graph.compensate', {});
        await engine.processRun(runId);
        expect((await runOf(database, runId)).status).toBe('FAILED');
        const stages = await stagesOf(database, runId);
        // fixup ran as compensation after boom failed
        expect(stages.some((s) => s.stage_id === 'fixup' && s.status === 'SUCCEEDED')).toBe(true);
        const decisions = await decisionsOf(database, runId);
        expect(
          decisions.some(
            (row) =>
              row.evidence?.compensation === true &&
              row.evidence?.forNode === 'writer' &&
              row.evidence?.failedNode === 'boom',
          ),
        ).toBe(true);
        const hops = await hopsOf(database, runId);
        expect(hops.at(-1)?.evidence).toMatchObject({
          from: 'boom',
          label: 'error',
          onCategory: 'internal',
        });
      },
      { deps: { toolRegistry: () => registry } },
    );
  });

  it('fails the run with budget_exceeded when the step budget is exhausted', async () => {
    await withEngine(async (engine, database) => {
      engine.registerStageHandler('t.echo', {
        execute: async (stage) => ({ output: { value: stage.input.value ?? 'x' } }),
      });
      engine.register(
        graphDef('test.graph.budget', {
          start: 'l',
          nodes: [
            { id: 'l', type: 'loop', loop: { maxIterations: 10, while: 'true' } },
            { id: 's', type: 'stage', kind: 't.echo' },
            { id: 'end', type: 'end', end: 'succeeded' },
          ],
          edges: [
            { from: 'l', to: 's', label: 'again' },
            { from: 's', to: 'l', label: 'next' },
            { from: 'l', to: 'end', label: 'done' },
          ],
          defaultErrorEdge: { to: 'end' },
          budget: { maxSteps: 4, maxDurationMs: 300_000 },
        }),
        'test',
        '0.1.0',
      );
      await cleanup(database, 'test.graph.budget');
      const { runId } = await engine.start('test.graph.budget', {});
      await engine.processRun(runId);
      const run = await runOf(database, runId);
      expect(run.status).toBe('FAILED');
      expect(run.error).toContain('budget of 4 steps');
      const decisions = await decisionsOf(database, runId);
      expect(decisions.some((row) => row.error?.category === 'budget_exceeded')).toBe(true);
    });
  });
});
