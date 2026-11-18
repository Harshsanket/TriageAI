import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runAgentStep, type AgentDefinition } from '../src/agents/runtime.js';
import { AgentCheckpointStore } from '../src/agents/runtime.js';
import { registerAgentWorkflow } from '../src/agents/workflow.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { MemoryStore } from '../src/memory/index.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import { ToolRegistry } from '../src/tools/index.js';
import type { ChatModel, ChatResponse, KernelLogger } from '../src/types.js';
import { WorkflowEngine } from '../src/workflow.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const definition: AgentDefinition = {
  id: 'researcher',
  displayName: 'Researcher',
  color: '#3b6fd4',
  version: 1,
  profile: 'Research the question and answer with citations.',
  job: {
    role: 'Answer the question',
    inputs: 'a question',
    output: 'an answer',
    doneWhen: 'the answer cites a source',
    domain: 'research',
  },
  agentReason: ['own_schedule'],
  tools: ['kb.search'],
  scopes: ['kb:read'],
  maxSteps: 4,
  egressClass: 'internal',
};

function makeModel(responses: ChatResponse[]): ChatModel {
  const chat = vi.fn(async () => responses.shift() as ChatResponse);
  return {
    chat,
    describe: () => ({
      provider: 'fake',
      model: 'fake',
      hosted: false,
      contextWindow: 8192,
      maxOutput: 1024,
      supportsTools: false,
      supportsStreaming: false,
    }),
  };
}

function response(content: string): ChatResponse {
  return {
    message: { role: 'assistant', content },
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'end',
    modelVersion: 'fake',
  };
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: 'kb.search',
    version: '1.0.0',
    owner: 'kb',
    description: 'Search approved knowledge chunks by meaning.',
    examples: [{ query: 'x' }],
    input: z.object({ query: z.string() }).strict(),
    output: z.object({ hits: z.array(z.string()) }).strict(),
    access: 'read',
    risk: 'low',
    scopes: ['kb:read'],
    egressClass: 'internal',
    idempotent: true,
    timeoutMs: 1000,
    undo: 'free',
    retry: { maxAttempts: 0, backoff: 'none', retryOn: [] },
    handler: async (input: { query: string }) => ({ hits: [`chunk for ${input.query}`] }),
  });
  return tools;
}

let database: PostgresDatabase;
const roots: string[] = [];
const runIds: string[] = [];
beforeAll(async () => {
  database = new PostgresDatabase(DATABASE_URL);
  await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
});
afterAll(async () => {
  if (runIds.length > 0) {
    await database.query(`DELETE FROM agent_steps WHERE run_id = ANY($1)`, [runIds]);
    await database.query(`DELETE FROM agent_checkpoints WHERE run_id = ANY($1)`, [runIds]);
    await database.query(`DELETE FROM stage_runs WHERE run_id = ANY($1)`, [runIds]);
    await database.query(`DELETE FROM decision_records WHERE run_id = ANY($1)`, [runIds]);
    await database.query(`DELETE FROM workflow_runs WHERE id = ANY($1)`, [runIds]);
  }
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  await database.close();
});

describeIfDb('agent.run workflow (phase 16.T1/T3/T6)', () => {
  it('runs a two-step graph, checkpoints each step and mirrors the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triageai-agent-wf-'));
    roots.push(root);
    const model = makeModel([
      response(
        '{"decision":"call_tool","tool":"kb.search","args":{"query":"refund"},"reason":"need facts"}',
      ),
      response('{"decision":"done","answer":"Five days [step:1]","reason":"grounded"}'),
    ]);
    const engine = new WorkflowEngine(database, logger);
    registerAgentWorkflow(engine, {
      database,
      tools: registry(),
      chatModel: () => model,
      logger,
      workspaceRoot: root,
    });

    const started = await engine.start('agent.run', {
      definition,
      goal: 'How long do refunds take?',
      agentId: definition.id,
      workspaceId: 'ws-agent-wf',
      skills: [
        {
          name: 'handoff',
          version: 1,
          content: '# Handoff\nWrite a compact handoff with decisions and next steps.',
        },
      ],
    });
    runIds.push(started.runId);
    await engine.processRun(started.runId);

    const run = await database.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE id = $1`,
      [started.runId],
    );
    expect(run[0]?.status).toBe('SUCCEEDED');
    const steps = await database.query<{ step_no: number; decision: string; payload: unknown }>(
      `SELECT step_no, decision, payload FROM agent_steps WHERE run_id = $1 ORDER BY step_no`,
      [started.runId],
    );
    expect(steps.map((step) => step.decision)).toEqual(['call_tool', 'done']);
    expect(steps[0]?.payload).toMatchObject({
      context: { hash: expect.any(String), needs: expect.any(Array) },
      contextPack: {
        skillCount: 1,
        skillIndexTokens: expect.any(Number),
        tokenMethod: 'chars/4',
      },
    });

    const state = await readFile(
      join(root, 'agents', definition.id, started.runId, 'state.json'),
      'utf8',
    );
    expect(state).toContain('How long do refunds take?');
    const progress = await readFile(
      join(root, 'agents', definition.id, started.runId, 'log', 'progress.md'),
      'utf8',
    );
    expect(progress.match(/step 1: call_tool/g)).toHaveLength(1);
    expect(progress).toContain('step 2: done');
    expect(
      await readFile(
        join(root, 'agents', definition.id, started.runId, 'decisions', '0002-decision.md'),
        'utf8',
      ),
    ).toContain('done');
  });

  it('resumes a killed run from the last committed step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triageai-agent-wf-resume-'));
    roots.push(root);
    const first = makeModel([
      response(
        '{"decision":"call_tool","tool":"kb.search","args":{"query":"refund"},"reason":"need facts"}',
      ),
    ]);
    const engine = new WorkflowEngine(database, logger);
    registerAgentWorkflow(engine, {
      database,
      tools: registry(),
      chatModel: () => first,
      logger,
      workspaceRoot: root,
    });
    const started = await engine.start('agent.run', {
      definition,
      goal: 'How long do refunds take?',
      agentId: definition.id,
    });
    runIds.push(started.runId);
    // Simulate a crash after step 1 committed but before the graph continued.
    const store = new AgentCheckpointStore(database);
    const part = await runAgentStep({
      runId: started.runId,
      definition,
      goal: 'How long do refunds take?',
      chatModel: first,
      tools: registry(),
      store,
      agentId: definition.id,
      workspaceRoot: root,
    });
    expect(part.state.step).toBe(1);

    const second = makeModel([
      response('{"decision":"done","answer":"Five days [step:1]","reason":"grounded"}'),
    ]);
    const resumedEngine = new WorkflowEngine(database, logger);
    registerAgentWorkflow(resumedEngine, {
      database,
      tools: registry(),
      chatModel: () => second,
      logger,
      workspaceRoot: root,
    });
    await resumedEngine.processRun(started.runId);
    const run = await database.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE id = $1`,
      [started.runId],
    );
    expect(run[0]?.status).toBe('SUCCEEDED');
    expect(second.chat).toHaveBeenCalledTimes(1);
    const steps = await database.query<{ step_no: number }>(
      `SELECT step_no FROM agent_steps WHERE run_id = $1 ORDER BY step_no`,
      [started.runId],
    );
    expect(steps.map((step) => step.step_no)).toEqual([0, 1]);
  });

  it('packs memory only when the need router selects it and marks used items', async () => {
    const memory = await new MemoryStore(database).write({
      scope: 'workspace',
      scopeId: 'ws-agent-memory',
      kind: 'preference',
      text: 'The user prefers concise answers',
      sourceRefs: ['test:memory'],
    });
    const model = makeModel([
      response(
        `{"decision":"done","answer":"Concise, as remembered [memory:${memory.id}]","reason":"memory"}`,
      ),
    ]);
    const engine = new WorkflowEngine(database, logger);
    registerAgentWorkflow(engine, { database, tools: registry(), chatModel: () => model, logger });
    const started = await engine.start('agent.run', {
      definition,
      goal: 'What does the user prefer?',
      agentId: definition.id,
      workspaceId: 'ws-agent-memory',
    });
    runIds.push(started.runId);
    await engine.processRun(started.runId);
    const rows = await database.query<{
      payload: {
        context?: { needs: string[]; included: Array<{ ref: string; used: boolean }> };
      };
    }>(`SELECT payload FROM agent_steps WHERE run_id = $1`, [started.runId]);
    const context = rows[0]?.payload.context;
    expect(context?.needs).toContain('memory');
    expect(context?.included.find((item) => item.ref === `memory:${memory.id}`)?.used).toBe(true);
  });
});
