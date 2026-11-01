import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Database, Kernel, KernelConfig } from '@triageai/kernel';

import { createCapabilities } from '../src/services/capabilities.js';
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
