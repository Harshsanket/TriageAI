/**
 * Chat module gates (Phase 18 leftovers, 18.T16/18.T26/18.T28):
 * - the module-side send gate on the chat summariser (chat.compact): secrets
 *   skip the summariser for the deterministic compactor, hosted+PII is masked
 *   before the model call;
 * - the per-app scope gate (chat.scope): out-of-scope requests get the scope
 *   message with ≤ 1 small-model call, 0 tool calls and no retrieval;
 * - sanitised delivery of chat replies;
 * - doc-assistant send gate + sanitised answer (same runtime harness).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, ChatModel, ChatResponse, Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

const SCOPE_REFUSAL = 'I could not verify this from the knowledge base.';
const DOC_REFUSAL = 'That is not documented (yet).';
const SECRET = 'sk-abcdefghijklmnop1234';
const EMAIL = 'alice@example.com';

function chatResponse(content: string): ChatResponse {
  return {
    message: { role: 'assistant', content },
    toolCalls: [],
    usage: { inputTokens: 12, outputTokens: 4 },
    stopReason: 'end',
    modelVersion: 'fake-chat',
  };
}

function fakeChatModel(args: {
  hosted: boolean;
  contextWindow?: number;
  respond: (prompt: string) => string;
}): ChatModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    describe: () => ({
      provider: 'fake',
      model: 'fake-chat',
      hosted: args.hosted,
      contextWindow: args.contextWindow ?? 8_192,
      maxOutput: 128,
      supportsTools: false,
      supportsStreaming: false,
    }),
    chat: async (req) => {
      const prompt = req.messages
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n');
      calls.push(prompt);
      return chatResponse(args.respond(prompt));
    },
  };
}

const openApps: Array<{ app: App; root: string }> = [];

afterEach(async () => {
  for (const { app, root } of openApps.reverse()) {
    await app.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  openApps.length = 0;
});

async function boot(capabilities: Capabilities, config: Record<string, unknown>): Promise<App> {
  const root = await mkdtemp(path.join(tmpdir(), 'triageai-chat-gate-'));
  const configPath = path.join(root, 'triage.config.json');
  await writeFile(configPath, JSON.stringify(config));
  const app = (await buildApp({
    quiet: true,
    configPath,
    capabilities,
    setup: false,
    // A developer's stored setup overlay must not change this suite (F10).
    useOverlay: false,
  })) as App;
  openApps.push({ app, root });
  return app;
}

function chatConfig(chatOptions: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profile: 'core',
    queue: { adapter: 'pg-queue', pollIntervalMs: 50 },
    modules: {
      chat: {
        enabled: true,
        options: { collection: 'chat_gate', knowledgeMode: 'prefer', ...chatOptions },
      },
      'ai-pipeline': { enabled: true },
    },
    capabilities: {},
  };
}

function docConfig(hosted: boolean): Record<string, unknown> {
  return {
    profile: 'core',
    queue: { adapter: 'pg-queue', pollIntervalMs: 250 },
    ...(hosted ? { hosted: { enabled: true, allowedProviders: [] } } : {}),
    modules: {
      'doc-assistant': {
        enabled: true,
        options: { docsDir: '/tmp', collection: 'project_docs_gate' },
      },
    },
    capabilities: {},
  };
}

async function ask(
  app: App,
  text: string,
  conversationId?: string,
): Promise<{ conversationId: string; runId: string }> {
  const sent = await app.inject({
    method: 'POST',
    url: '/api/v1/chat/messages',
    payload: conversationId ? { conversationId, text } : { text },
  });
  expect(sent.statusCode).toBe(200);
  const body = sent.json() as { conversationId: string; runId: string };
  return { conversationId: body.conversationId, runId: body.runId };
}

async function waitForAssistant(app: App, conversationId: string, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}`,
    });
    const body = res.json() as {
      messages: Array<{ role: string; content: string; citations: string[] }>;
    };
    const assistant = body.messages.find((message) => message.role === 'assistant');
    if (assistant) return assistant;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the assistant');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForCompaction(app: App, conversationId: string, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const rows = await app.kernel!.database.query<{
      summary: string | null;
      context: Record<string, unknown> | null;
    }>(`SELECT summary, context FROM mod_chat.chat_conversations WHERE id = $1`, [conversationId]);
    // The first turn also writes a context record (compacted: false); wait for
    // the follow-up turn's compaction pass instead of returning the stale row.
    if (rows[0]?.context && rows[0].context.compacted === true) {
      return { summary: rows[0].summary, context: rows[0].context };
    }
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for compaction');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 30 seeded turns, mirroring the compaction fixture shape. */
async function seedTurns(app: App, conversationId: string, decorate: (index: number) => string) {
  for (let index = 0; index < 30; index += 1) {
    await app.kernel!.database.query(
      `INSERT INTO mod_chat.chat_messages (id, conversation_id, role, content)
       VALUES ($1, $2, $3, $4)`,
      [
        `seed-${Date.now()}-${conversationId}-${index}`,
        conversationId,
        index % 2 === 0 ? 'user' : 'assistant',
        `Turn ${index}: the refund policy is five business days and we must always cite it.${decorate(index)} ${'context '.repeat(40)}`,
      ],
    );
  }
}

describeIfDb('chat scope gate (18.T26)', () => {
  it('answers an out-of-scope request with the scope message: ≤1 small call, 0 tools, no retrieval', async () => {
    let retrieverCalls = 0;
    const model = fakeChatModel({
      hosted: false,
      respond: () => '{"intent":"other","inScope":false,"confidence":0.95}',
    });
    const app = await boot(
      {
        chatModel: model,
        retriever: {
          search: async () => {
            retrieverCalls += 1;
            return {
              chunks: [],
              gate: {
                sufficient: false,
                topScore: 0,
                margin: 0,
                threshold: 0.35,
                marginThreshold: 0.05,
              },
            };
          },
        },
      },
      chatConfig(),
    );

    const sent = await ask(app, 'Send this to the billing team by email');
    const assistant = await waitForAssistant(app, sent.conversationId);
    expect(assistant.content).toBe(SCOPE_REFUSAL);
    expect(assistant.citations).toEqual([]);
    expect(model.calls.length).toBe(1);
    expect(retrieverCalls).toBe(0);

    const traces = await app.kernel!.database.query<{
      trace: { task: string; toolCalls: unknown[]; modelName: string };
    }>(
      `SELECT trace FROM model_call_traces WHERE task = 'intent_gate' AND run_id = $1 ORDER BY at DESC LIMIT 1`,
      [sent.runId],
    );
    expect(traces[0]?.trace.modelName).toBe('fake-chat');
    expect(traces[0]?.trace.toolCalls).toEqual([]);
  });

  it('keeps in-scope requests flowing without a gate call', async () => {
    let gateCalls = 0;
    const model = fakeChatModel({
      hosted: false,
      respond: (prompt) => {
        if (prompt.includes('Classify the user request')) {
          gateCalls += 1;
          return '{"intent":"general","inScope":true,"confidence":0.9}';
        }
        return /\bhi\b/i.test(prompt.split('Question:').at(-1) ?? '')
          ? 'Hello! How can I help?'
          : 'A general answer.';
      },
    });
    const app = await boot({ chatModel: model }, chatConfig());

    const conversationId = (await ask(app, 'hi')).conversationId;
    const assistant = await waitForAssistant(app, conversationId);
    expect(assistant.content).toContain('Hello!');
    expect(gateCalls).toBe(0);
  });
});

describeIfDb('chat summary send gate (18.T16)', () => {
  it('skips the summariser for the deterministic compactor when the transcript holds a secret', async () => {
    const model = fakeChatModel({
      hosted: true,
      contextWindow: 1_200,
      respond: (prompt) =>
        prompt.includes('Compact this conversation') ? 'MODEL SUMMARY LEAKED' : 'A general answer.',
    });
    const app = await boot(
      { chatModel: model },
      chatConfig({ fallbackContextWindow: 1_200, maxAnswerTokens: 128 }),
    );

    const first = await ask(app, 'long conversation with secrets');
    await seedTurns(app, first.conversationId, (index) =>
      index < 3 ? ` API key: ${SECRET}.` : '',
    );
    await ask(app, 'What did we decide about refunds?', first.conversationId);
    const { summary, context } = await waitForCompaction(app, first.conversationId);

    expect(context).toMatchObject({ compacted: true, degraded: true });
    // The deterministic compactor (26.T5) ran, not the model.
    expect(summary).toMatch(/Decisions:/);
    expect(summary).toMatch(/refund policy is five business days/);
    expect(summary).not.toContain(SECRET);
    expect(summary).not.toContain('MODEL SUMMARY LEAKED');
    expect(model.calls.every((prompt) => !prompt.includes('Compact this conversation'))).toBe(true);
    expect(model.calls.every((prompt) => !prompt.includes(SECRET))).toBe(true);
  });

  it('masks PII before the hosted summariser call and stores the sanitised summary', async () => {
    const model = fakeChatModel({
      hosted: true,
      contextWindow: 1_200,
      respond: (prompt) =>
        prompt.includes('Compact this conversation')
          ? 'Earlier: the billing contact was masked.'
          : 'A general answer.',
    });
    const app = await boot(
      { chatModel: model },
      chatConfig({ fallbackContextWindow: 1_200, maxAnswerTokens: 128 }),
    );

    const first = await ask(app, 'long conversation with pii');
    await seedTurns(app, first.conversationId, (index) =>
      index < 3 ? ` Write to ${EMAIL} about it.` : '',
    );
    await ask(app, 'What did we decide about refunds?', first.conversationId);
    const { summary } = await waitForCompaction(app, first.conversationId);

    expect(summary).toBe('Earlier: the billing contact was masked.');
    const compactPrompt = model.calls.find((prompt) =>
      prompt.includes('Compact this conversation'),
    );
    expect(compactPrompt).toBeDefined();
    expect(compactPrompt).toContain('<PII:EMAIL_1>');
    expect(model.calls.every((prompt) => !prompt.includes(EMAIL))).toBe(true);
  });
});

describeIfDb('sanitised chat delivery (18.T28)', () => {
  it('stores and delivers a sanitised reply', async () => {
    const app = await boot(
      {
        generator: {
          generate: async () => ({
            text: 'See <img src=x> here and javascript:alert(1) too.',
            modelVersion: 'fake-gen',
          }),
        },
      },
      chatConfig(),
    );

    const { conversationId } = await ask(app, 'Show me an example');
    const assistant = await waitForAssistant(app, conversationId);
    expect(assistant.content).toBe('See [image removed] here and alert(1) too.');
    expect(assistant.content).not.toContain('<img');
    expect(assistant.content).not.toContain('javascript:');
  });

  it('scrubs a pasted secret before storage and audits it (18.T15)', async () => {
    const app = await boot(
      {
        generator: {
          generate: async () => ({ text: 'Noted.', modelVersion: 'fake-gen' }),
        },
      },
      chatConfig(),
    );

    const { conversationId } = await ask(app, `my key is ${SECRET} please keep it`);
    await waitForAssistant(app, conversationId);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}`,
    });
    const messages = (res.json() as { messages: Array<{ role: string; content: string }> })
      .messages;
    const user = messages.find((message) => message.role === 'user');
    expect(user?.content).not.toContain(SECRET);
    expect(user?.content).toContain('[REDACTED:api_key]');
    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'chat.secret_scrubbed'`,
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it('masks PII in chat exports (18.T31)', async () => {
    const app = await boot(
      {
        generator: {
          generate: async () => ({ text: 'Noted.', modelVersion: 'fake-gen' }),
        },
      },
      chatConfig(),
    );
    const { conversationId } = await ask(app, `contact ${EMAIL} about the invoice`);
    await waitForAssistant(app, conversationId);

    const json = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/export?format=json`,
    });
    const body = json.json() as { messages: Array<{ content: string }> };
    expect(body.messages.some((message) => message.content.includes(EMAIL))).toBe(false);
    expect(body.messages.some((message) => message.content.includes('<PII:EMAIL_1>'))).toBe(true);

    const markdown = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}/export`,
    });
    expect(markdown.body).not.toContain(EMAIL);
    expect(markdown.body).toContain('<PII:EMAIL_1>');
  });
});

describeIfDb('doc-assistant send gate and sanitised answer (18.T16/18.T28)', () => {
  function docCapabilities(counters: { retrieverCalls: number; prompts: string[] }): Capabilities {
    return {
      embedder: {
        embed: async (texts: string[]) => ({
          vectors: texts.map(() => [0.1, 0.2]),
          modelVersion: 'fake-embed',
        }),
      },
      vectorStore: {
        upsert: async () => undefined,
        search: async () => [],
        deleteByDocument: async () => undefined,
      },
      retriever: {
        search: async () => {
          counters.retrieverCalls += 1;
          return {
            chunks: [
              {
                id: 'chunk-kernel',
                collection: 'project_docs_gate',
                documentId: 'kernel.md',
                text: 'The kernel boots modules in dependency order after applying migrations.',
                score: 0.9,
                metadata: { path: 'kernel.md' },
              },
            ],
            gate: {
              sufficient: true,
              topScore: 0.9,
              margin: 0.5,
              threshold: 0.35,
              marginThreshold: 0.05,
            },
          };
        },
      },
      generator: {
        generate: async (prompt: string) => {
          counters.prompts.push(prompt);
          return {
            text: 'The kernel boots modules in dependency order after applying migrations. <img src=x> javascript:alert(1)',
            modelVersion: 'fake-gen',
          };
        },
      },
    };
  }

  it('refuses a withheld question without a model call', async () => {
    const counters = { retrieverCalls: 0, prompts: [] as string[] };
    const app = await boot(docCapabilities(counters), docConfig(true));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/doc-assistant/ask',
      payload: { question: `what uses the api key ${SECRET}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      answer: string;
      refused: boolean;
      reason: string;
      citations: string[];
    };
    expect(body.refused).toBe(true);
    expect(body.answer).toBe(DOC_REFUSAL);
    expect(body.reason).toBe('send_gate_withheld:secret');
    expect(body.citations).toEqual([]);
    expect(counters.retrieverCalls).toBe(0);
    expect(counters.prompts.length).toBe(0);
  });

  it('masks PII in the prompt and sanitises the generated answer', async () => {
    const counters = { retrieverCalls: 0, prompts: [] as string[] };
    const app = await boot(docCapabilities(counters), docConfig(false));

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/doc-assistant/ask',
      payload: { question: `how do I contact ${EMAIL} about the kernel boot` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      answer: string;
      refused: boolean;
      citations: string[];
    };
    expect(body.refused).toBe(false);
    expect(body.citations).toEqual(['kernel.md']);
    expect(counters.prompts.length).toBe(1);
    expect(counters.prompts[0]).toContain('<PII:EMAIL_1>');
    expect(counters.prompts.every((prompt) => !prompt.includes(EMAIL))).toBe(true);
    expect(body.answer).not.toContain('<img');
    expect(body.answer).not.toContain('javascript:');
    expect(body.answer).toContain('[image removed]');
    expect(body.answer).toContain('[kernel.md]');
  });
});
