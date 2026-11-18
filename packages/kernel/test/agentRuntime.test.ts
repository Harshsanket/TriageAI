import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AgentCheckpointStore, runAgent, type AgentDefinition } from '../src/agents/runtime.js';
import { buildAgentStepContext, gateContextItems } from '../src/agents/context.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import { ToolRegistry } from '../src/tools/index.js';
import type { ChatModel, ChatResponse, KernelLogger } from '../src/types.js';

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
  version: 1,
  profile: 'Research the ticket and answer.',
  job: {
    role: 'Answer the ticket',
    inputs: 'ticket text',
    output: 'an answer',
    doneWhen: 'the answer cites a source',
    domain: 'support',
  },
  agentReason: ['own_schedule'],
  tools: ['kb.search'],
  scopes: ['kb:read'],
  maxSteps: 2,
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
beforeAll(async () => {
  database = new PostgresDatabase(DATABASE_URL);
  await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
});
afterAll(async () => {
  await database.query(`DELETE FROM agent_steps WHERE run_id LIKE 'test-%'`);
  await database.query(`DELETE FROM agent_checkpoints WHERE run_id LIKE 'test-%'`);
  await database.close();
});

describe('context pack send gate (18.T16)', () => {
  it('withholds secrets and redacts PII before packing', () => {
    const gated = gateContextItems(
      [
        {
          ref: 'memory:secret',
          source: 'memory',
          text: 'token sk-abcdefghijklmnop1234',
          reason: 'memory_match',
          tokens: 5,
          sensitivity: 'internal',
        },
        {
          ref: 'memory:pii',
          source: 'memory',
          text: 'email alice@example.com',
          reason: 'memory_match',
          tokens: 5,
          sensitivity: 'internal',
        },
      ],
      false,
    );
    expect(gated[0]?.send).toBe('withheld');
    expect(gated[1]?.send).not.toBe('withheld');
    expect(gated[1]?.text).not.toContain('alice@example.com');
  });
});

describeIfDb('agent runtime (phase 16.1 core)', () => {
  it('runs a bounded structured loop and checkpoints every step', async () => {
    const chatModel = makeModel([
      response(
        '{"decision":"call_tool","tool":"kb.search","args":{"query":"refund"},"reason":"need facts"}',
      ),
      response('{"decision":"done","answer":"Five days [kb:1]","reason":"grounded"}'),
    ]);
    const store = new AgentCheckpointStore(database);
    const result = await runAgent({
      runId: `test-${Date.now()}`,
      definition,
      goal: 'How long do refunds take?',
      chatModel,
      tools: registry(),
      store,
      logger,
    });
    expect(result.state).toMatchObject({ status: 'done', step: 2, answer: 'Five days [kb:1]' });
    expect(result.state.notes[0]).toContain('kb.search');
    expect(chatModel.chat).toHaveBeenCalledTimes(2);
  });

  it('resumes from the last checkpoint without repeating completed steps', async () => {
    const runId = `test-resume-${Date.now()}`;
    const store = new AgentCheckpointStore(database);
    const first = makeModel([
      response(
        '{"decision":"call_tool","tool":"kb.search","args":{"query":"refund"},"reason":"need facts"}',
      ),
    ]);
    const part = await runAgent({
      runId,
      definition: { ...definition, maxSteps: 1 },
      goal: 'How long do refunds take?',
      chatModel: first,
      tools: registry(),
      store,
      logger,
    });
    expect(part.state.status).toBe('running');

    const second = makeModel([
      response('{"decision":"done","answer":"Five days [kb:1]","reason":"grounded"}'),
    ]);
    const resumed = await runAgent({
      runId,
      definition,
      goal: 'How long do refunds take?',
      chatModel: second,
      tools: registry(),
      store,
      logger,
    });
    expect(resumed.resumed).toBe(true);
    expect(resumed.state).toMatchObject({ status: 'done', step: 2 });
    expect(second.chat).toHaveBeenCalledTimes(1);
  });

  it('gates tool observations before the next model call (18.T16)', async () => {
    const secret = 'sk-abcdefghijklmnop1234';
    const tools = registry();
    tools.register({
      name: 'kb.get_secret',
      version: '1.0.0',
      owner: 'kb',
      description: 'Return a tool result that contains a pasted secret.',
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
      handler: async () => ({ hits: [secret] }),
    });
    const model = makeModel([
      response(
        '{"decision":"call_tool","tool":"kb.get_secret","args":{"query":"x"},"reason":"need it"}',
      ),
      response('{"decision":"done","answer":"ok","reason":"done"}'),
    ]);
    const store = new AgentCheckpointStore(database);
    await runAgent({
      runId: `test-gate-${Date.now()}`,
      definition: { ...definition, tools: ['kb.search', 'kb.get_secret'] },
      goal: 'fetch the thing',
      chatModel: model,
      tools,
      store,
      logger,
    });
    const calls = (model.chat as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const secondCall = JSON.stringify(calls[1] ?? []);
    expect(secondCall).not.toContain(secret);
    expect(secondCall).toContain('withheld');
  });

  it('drops short-term history for scheduled runs (18.T33)', async () => {
    const state = {
      goal: 'what about that open item',
      step: 0,
      status: 'running' as const,
      notes: ['chatty history that must not leak'],
    };
    const base = {
      definition,
      goal: state.goal,
      state,
      step: 0,
      hosted: false,
      windowTokens: 8192,
      lastTool: 'kb.search',
    };
    const scheduled = await buildAgentStepContext({ ...base, trigger: 'schedule' });
    expect(scheduled.promptText).not.toContain('chatty history');
    const interactive = await buildAgentStepContext({ ...base, trigger: 'endpoint' });
    expect(interactive.promptText).toContain('chatty history');
  });
});
