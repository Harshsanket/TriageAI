import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatModel, Database, Kernel, KernelConfig } from '@triageai/kernel';

import {
  OllamaGenerator,
  OpenAICompatibleGenerator,
  PooledChatModel,
  createCapabilities,
  estimateCostFromRouting,
} from '../src/services/capabilities.js';
import { readModelRuntimes } from '../src/services/modelRuntimes.js';

function fakeDatabase(controls: Record<string, unknown> = {}): Database {
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM settings')) return [{ value: controls }];
      if (sql.includes('uptime_probes')) return [];
      return [];
    },
    transaction: async <T>(fn: (tx: Database) => Promise<T>) => fn(fakeDatabase(controls)),
    close: async () => undefined,
  } as unknown as Database;
}

function config(overrides: Record<string, unknown> = {}): KernelConfig {
  return {
    profile: 'core',
    queue: { adapter: 'pg-queue' },
    modules: {},
    capabilities: {},
    ...overrides,
  } as KernelConfig;
}

const jsonHeaders = { 'content-type': 'application/json' };

function chatResponse(model: string, content = 'ok'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }),
    { status: 200, headers: jsonHeaders },
  );
}

/** OpenAI-compatible hosted runtime on a public IP literal: egress resolves it
 * without DNS and the stubbed fetch answers, so hosted-path tests are offline. */
const HOSTED_BASE = 'http://198.51.100.7:9/v1';
const HOSTED_HOST = '198.51.100.7';
const HOSTED_RUNTIME = { adapter: 'openai_compatible', model: 'gpt-hosted', baseUrl: HOSTED_BASE };
const HOSTED_ALLOWED = { hosted: { enabled: true, allowedProviders: ['openai_compatible'] } };
const HOSTED_EGRESS = {
  egress: { allowlist: [{ host: HOSTED_HOST, dataClass: 'internal' }] },
};

describe('model runtime inventory and kill switches', () => {
  afterEach(() => vi.unstubAllGlobals());

  const kernel = (controls: Record<string, unknown>, cfg: KernelConfig) =>
    ({
      config: cfg,
      modules: ['chat', 'support'],
      database: fakeDatabase(controls),
    }) as unknown as Kernel;

  it('lists every configured runtime with its features', async () => {
    const runtimes = await readModelRuntimes(
      kernel(
        {},
        config({
          capabilities: {
            runtimes: [
              { adapter: 'ollama', model: 'qwen2.5:1.5b', contextWindow: 32768 },
              { adapter: 'openai', model: 'gpt-test', hosted: true },
            ],
          },
        }),
      ),
    );
    expect(runtimes.map((runtime) => runtime.id)).toEqual([
      'ollama:qwen2.5:1.5b',
      'openai:gpt-test',
    ]);
    expect(runtimes[0]?.features).toContain('chat');
    expect(runtimes[1]?.hosted).toBe(true);
    expect(runtimes.every((runtime) => runtime.enabled)).toBe(true);
  });

  it('marks the global switch and individual runtimes as disabled', async () => {
    const global = await readModelRuntimes(
      kernel(
        { llmDisabled: true },
        config({ capabilities: { generator: { adapter: 'ollama', model: 'local' } } }),
      ),
    );
    expect(global[0]?.status).toBe('disabled');
    expect(global[0]?.enabled).toBe(false);

    const individual = await readModelRuntimes(
      kernel(
        { disabledRuntimes: ['ollama:local'] },
        config({ capabilities: { generator: { adapter: 'ollama', model: 'local' } } }),
      ),
    );
    expect(individual[0]?.status).toBe('disabled');

    const moduleProvided = await readModelRuntimes(
      kernel(
        {},
        config({
          modules: { 'llm-local': { enabled: true, options: { model: 'small' } } },
          capabilities: { egress: { adapter: 'host' } },
        }),
      ),
    );
    expect(moduleProvided.map((runtime) => runtime.id)).toContain('llm-local:small');
  });

  it('refuses a model call before any network request while disabled', async () => {
    const capabilities = createCapabilities(
      config({
        capabilities: {
          chatModel: {
            adapter: 'openai_compatible_local',
            model: 'local-test',
            baseUrl: 'http://127.0.0.1:9',
          },
        },
      }),
      'http://127.0.0.1:9',
      fakeDatabase({ llmDisabled: true }),
    );
    await expect(
      capabilities.chatModel?.chat({
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 16,
      }),
    ).rejects.toMatchObject({ code: 'models.DISABLED', retryable: false });
  });

  it('selects only enabled runtimes from a configured pool', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          model: 'second',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const capabilities = createCapabilities(
      config({
        capabilities: {
          runtimes: [
            {
              adapter: 'openai_compatible_local',
              model: 'first',
              baseUrl: 'http://first.test/v1',
            },
            {
              adapter: 'openai_compatible_local',
              model: 'second',
              baseUrl: 'http://second.test/v1',
            },
          ],
        },
      }),
      'http://127.0.0.1:9',
      fakeDatabase({ disabledRuntimes: ['openai_compatible_local:first'] }),
    );
    const result = await capabilities.chatModel?.chat({
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 16,
    });
    expect(result?.message.content).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('second.test');
  });

  it('refuses cache/fallback paths for a disabled runtime id', async () => {
    const capabilities = createCapabilities(
      config({
        capabilities: {
          chatModel: {
            adapter: 'openai_compatible_local',
            model: 'local-test',
            baseUrl: 'http://127.0.0.1:9',
          },
        },
      }),
      'http://127.0.0.1:9',
      fakeDatabase({ disabledRuntimes: ['openai_compatible_local:local-test'] }),
    );
    await expect(
      capabilities.chatModel?.chat({
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 16,
      }),
    ).rejects.toMatchObject({ code: 'models.DISABLED' });
  });
});

describe('pool routing table (19.2/25.T5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('routes a configured task to its primary runtime, first-enabled otherwise', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return chatResponse('second');
    });
    const capabilities = createCapabilities(
      config({
        capabilities: {
          runtimes: [
            {
              adapter: 'openai_compatible_local',
              model: 'first',
              baseUrl: 'http://first.test/v1',
            },
            {
              adapter: 'openai_compatible_local',
              model: 'second',
              baseUrl: 'http://second.test/v1',
            },
          ],
        },
        routing: { tasks: { classify: { primary: 'openai_compatible_local:second' } } },
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    const pool = capabilities.chatModel as PooledChatModel;
    const routed = await pool.chat(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
      { task: 'classify' },
    );
    expect(routed.message.content).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('second.test');
    expect(pool.lastRoutingReason).toBe('configured_primary');

    calls.length = 0;
    await pool.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('first.test');
    expect(pool.lastRoutingReason).toBeNull();
  });

  it('maxCostPerCall excludes a priced hosted runtime when a cheaper local exists', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return chatResponse('gpt-hosted');
    });
    const capabilities = createCapabilities(
      config({
        capabilities: {
          runtimes: [
            HOSTED_RUNTIME,
            {
              adapter: 'openai_compatible_local',
              model: 'qwen',
              baseUrl: 'http://local.test/v1',
            },
          ],
        },
        ...HOSTED_ALLOWED,
        routing: {
          tasks: { answer: { primary: 'openai_compatible:gpt-hosted', maxCostPerCall: 0.001 } },
          prices: {
            'openai_compatible:gpt-hosted': { outputPer1k: 3 },
            'openai_compatible_local:qwen': { outputPer1k: 0 },
          },
        },
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    const pool = capabilities.chatModel as PooledChatModel;
    const result = await pool.chat(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
      { task: 'answer' },
    );
    expect(result.message.content).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('local.test');
    expect(pool.lastRoutingReason).toBe('any_eligible_model');
  });

  it('restricted sensitivity never selects a hosted runtime (egress precedence)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return chatResponse('qwen', 'local-answer');
    });
    const capabilities = createCapabilities(
      config({
        capabilities: {
          runtimes: [
            HOSTED_RUNTIME,
            {
              adapter: 'openai_compatible_local',
              model: 'qwen',
              baseUrl: 'http://local.test/v1',
            },
          ],
        },
        ...HOSTED_ALLOWED,
        routing: {
          tasks: { answer: { primary: 'openai_compatible:gpt-hosted', sensitivity: 'restricted' } },
        },
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    const pool = capabilities.chatModel as PooledChatModel;
    const result = await pool.chat(
      { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
      { task: 'answer' },
    );
    expect(result.message.content).toBe('local-answer');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('local.test');
    expect(pool.lastRoutingReason).toBe('any_eligible_model');
  });

  it('refuses a restricted task instead of egressing when only hosted runtimes exist', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return chatResponse('gpt-hosted');
    });
    const capabilities = createCapabilities(
      config({
        capabilities: { runtimes: [HOSTED_RUNTIME] },
        ...HOSTED_ALLOWED,
        routing: {
          tasks: { answer: { primary: 'openai_compatible:gpt-hosted', sensitivity: 'restricted' } },
        },
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    await expect(
      (capabilities.chatModel as PooledChatModel).chat(
        { messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 },
        { task: 'answer' },
      ),
    ).rejects.toMatchObject({ code: 'models.EGRESS_BLOCKED', category: 'policy_blocked' });
    expect(calls).toHaveLength(0);
  });
});

describe('switch_model fallback (14.T3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries once on the local runtime when the hosted runtime fails', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (String(url).includes(HOSTED_HOST)) {
        return new Response(JSON.stringify({ error: 'upstream down' }), {
          status: 500,
          headers: jsonHeaders,
        });
      }
      return chatResponse('qwen', 'local-answer');
    });
    const capabilities = createCapabilities(
      config({
        capabilities: {
          runtimes: [
            HOSTED_RUNTIME,
            { adapter: 'openai_compatible_local', model: 'qwen', baseUrl: 'http://local.test/v1' },
          ],
        },
        ...HOSTED_ALLOWED,
        ...HOSTED_EGRESS,
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    const pool = capabilities.chatModel as PooledChatModel;
    const result = await pool.chat({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 8 });
    expect(result.message.content).toBe('local-answer');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(HOSTED_HOST);
    expect(calls[1]).toContain('local.test');
    expect(pool.lastRoutingReason).toBe('switch_model_hosted_to_local');
  });

  it('propagates the hosted failure when no local runtime exists', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: 'upstream down' }), {
          status: 500,
          headers: jsonHeaders,
        }),
    );
    const capabilities = createCapabilities(
      config({
        capabilities: { runtimes: [HOSTED_RUNTIME] },
        ...HOSTED_ALLOWED,
        ...HOSTED_EGRESS,
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    await expect(
      capabilities.chatModel?.chat({
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 16,
      }),
    ).rejects.toMatchObject({ code: 'chatmodel.UNAVAILABLE', category: 'dependency_unavailable' });
    expect((capabilities.chatModel as PooledChatModel).lastRoutingReason).toBeNull();
  });

  it('keeps the local failure as-is (no hosted escalation)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: 'down' }), { status: 500, headers: jsonHeaders });
    });
    const capabilities = createCapabilities(
      config({
        capabilities: {
          runtimes: [
            { adapter: 'openai_compatible_local', model: 'qwen', baseUrl: 'http://local.test/v1' },
            HOSTED_RUNTIME,
          ],
        },
        ...HOSTED_ALLOWED,
        ...HOSTED_EGRESS,
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    await expect(
      capabilities.chatModel?.chat({
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 16,
      }),
    ).rejects.toMatchObject({ code: 'chatmodel.UNAVAILABLE' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('local.test');
  });
});

describe('generator wraps the runtime ChatModel (14.T1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('delegates generate() to the matching runtime ChatModel instead of HTTP', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          model: 'qwen',
          message: { content: 'chat-path' },
          prompt_eval_count: 4,
          eval_count: 6,
          done_reason: 'stop',
        }),
        { status: 200, headers: jsonHeaders },
      );
    });
    const capabilities = createCapabilities(
      config({
        capabilities: {
          runtimes: [{ adapter: 'ollama', model: 'qwen', baseUrl: 'http://ollama.test' }],
          generator: { adapter: 'ollama', model: 'qwen', baseUrl: 'http://ollama.test' },
        },
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    const result = await capabilities.generator?.generate('say hi');
    expect(result?.text).toBe('chat-path');
    expect(result?.usage).toMatchObject({ promptTokens: 4, completionTokens: 6 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/chat');
  });

  it('keeps the legacy /api/generate path without a matching runtime', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          response: 'legacy',
          model: 'qwen',
          prompt_eval_count: 4,
          eval_count: 6,
          total_duration: 1_000_000,
        }),
        { status: 200, headers: jsonHeaders },
      );
    });
    const capabilities = createCapabilities(
      config({
        capabilities: {
          generator: { adapter: 'ollama', model: 'qwen', baseUrl: 'http://ollama.test' },
        },
      }),
      'http://127.0.0.1:9',
      fakeDatabase(),
    );
    const result = await capabilities.generator?.generate('say hi');
    expect(result?.text).toBe('legacy');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/generate');
  });

  it('generator adapters call the injected ChatModel, never the wire', async () => {
    const chatRequests: Array<{ messages: unknown; maxTokens: unknown; temperature: unknown }> = [];
    const fakeChat: ChatModel = {
      chat: async (request) => {
        chatRequests.push({
          messages: request.messages,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
        });
        return {
          message: { role: 'assistant', content: 'fake' },
          toolCalls: [],
          usage: { inputTokens: 2, outputTokens: 3 },
          stopReason: 'end',
          modelVersion: 'fake-1',
        };
      },
      describe: () => ({
        provider: 'fake',
        model: 'fake',
        hosted: false,
        contextWindow: 1024,
        maxOutput: 256,
        supportsTools: false,
        supportsStreaming: false,
      }),
    };
    let httpCalls = 0;
    const fetchMock = (async () => {
      httpCalls += 1;
      return chatResponse('x');
    }) as unknown as typeof fetch;
    const ollama = new OllamaGenerator('http://ollama.test', 'qwen', fetchMock, fakeChat);
    expect(await ollama.generate('say hi', { maxTokens: 64, temperature: 0.5 })).toMatchObject({
      text: 'fake',
      modelVersion: 'fake-1',
      usage: { promptTokens: 2, completionTokens: 3 },
    });
    const openai = new OpenAICompatibleGenerator(
      'http://x.test/v1',
      'qwen',
      'key',
      fetchMock,
      fakeChat,
    );
    await openai.generate('say hi', { maxTokens: 64 });
    expect(chatRequests).toEqual([
      {
        messages: [{ role: 'user', content: 'say hi' }],
        maxTokens: 64,
        temperature: 0.5,
      },
      {
        messages: [{ role: 'user', content: 'say hi' }],
        maxTokens: 64,
        temperature: undefined,
      },
    ]);
    expect(chatRequests).toHaveLength(2);
    expect(httpCalls).toBe(0);
  });
});

describe('estimateCostFromRouting (19.3 price table)', () => {
  const routing = {
    prices: { 'openai:gpt-test': { inputPer1k: 0.5, outputPer1k: 1.5 } },
  };

  it('bills input (minus cached) and output tokens at their per-1K price', () => {
    expect(estimateCostFromRouting(routing, 'openai', 'gpt-test', 1_000, 2_000, 300)).toBeCloseTo(
      3.35,
    );
  });

  it('returns 0 for unknown models, missing tables and fully cached input', () => {
    expect(estimateCostFromRouting(routing, 'openai', 'unknown', 1_000, 2_000, 0)).toBe(0);
    expect(estimateCostFromRouting(undefined, 'openai', 'gpt-test', 1_000, 2_000, 0)).toBe(0);
    expect(estimateCostFromRouting(routing, 'openai', 'gpt-test', 1_000, 1_000, 1_000)).toBeCloseTo(
      1.5,
    );
  });
});
