import { afterEach, describe, expect, it, vi } from 'vitest';

import { SetupAnswersSchema, type HardwareProfile } from '@triageai/contracts';
import { parseConfigFile } from '@triageai/kernel';

import { MODULES } from '../src/app.js';
import { fitFor, quantOf, searchHuggingFace, SEARCH_QUERY } from '../src/setup/catalog.js';
import { modelBudget } from '../src/setup/hardware.js';
import { planSetup } from '../src/setup/plan.js';

const GIB = 1024 ** 3;
const HARDWARE: HardwareProfile = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'Apple M2',
  cpuCores: 8,
  memoryTotalBytes: 16 * GIB,
  memoryFreeBytes: 8 * GIB,
  appleSilicon: true,
  gpu: null,
  diskFreeBytes: 200 * GIB,
  modelBudgetBytes: 8 * GIB,
  tier: 'medium',
  services: { aiService: false, ollama: false },
};

afterEach(() => {
  vi.unstubAllGlobals();
});
const plan = (answers: unknown, env: NodeJS.ProcessEnv = {}) =>
  planSetup(SetupAnswersSchema.parse(answers), parseConfigFile({}), MODULES, env);

describe('setup planner', () => {
  it('turns chatbot + ticket solver with a local model into a bootable overlay', () => {
    const result = plan({
      interfaces: ['chatbot', 'ticket-solver'],
      llm: { runtime: 'ollama', model: 'qwen2.5:1.5b' },
    });
    expect(result.problems).toEqual([]);
    expect(result.enabledModules).toEqual(['ai-pipeline', 'chat', 'kb', 'support']);
    expect(result.overlay).toMatchObject({
      profile: 'support',
      modules: { echo: { enabled: false }, support: { options: { defaultCollection: 'kb_docs' } } },
      capabilities: {
        generator: { adapter: 'ollama', model: 'qwen2.5:1.5b', baseUrl: 'http://localhost:11434' },
        retriever: { adapter: 'pgvector' },
        classifier: { adapter: 'ai-service' },
      },
    });
  });

  it('blocks answer-writing interfaces without an LLM and notifications without tickets', () => {
    const result = plan({
      interfaces: ['chatbot', 'notifications-slack'],
      llm: { runtime: 'none' },
    });
    expect(result.problems.join('\n')).toMatch(/need an LLM runtime/);
    expect(result.problems.join('\n')).toMatch(/need the ticket solver/);
  });

  it('lists credentials as secrets and never puts them in the overlay', () => {
    const result = plan({
      interfaces: ['ticket-solver', 'notifications-github'],
      llm: { runtime: 'none' },
      integrations: { githubRepo: 'acme/help', githubToken: 'ghp_secret' },
    });
    expect(result.secrets).toEqual(['GITHUB_TOKEN']);
    expect(JSON.stringify(result.overlay)).not.toContain('ghp_secret');
    expect(result.overlay).toMatchObject({
      modules: { 'integrations-github': { enabled: true, options: { repo: 'acme/help' } } },
    });
  });

  it('warns when an env override will shadow the chosen runtime URL', () => {
    const result = plan(
      { interfaces: ['chatbot'], llm: { runtime: 'ollama', model: 'm' } },
      { TRIAGEAI_GENERATOR_BASE_URL: 'http://ollama:11434' },
    );
    expect(result.warnings.join('\n')).toMatch(/TRIAGEAI_GENERATOR_BASE_URL/);
  });

  it('requires a model whenever a runtime is chosen', () => {
    expect(() =>
      SetupAnswersSchema.parse({ interfaces: ['chatbot'], llm: { runtime: 'ollama' } }),
    ).toThrow();
  });
});

describe('model catalog helpers', () => {
  it('reads the quantisation from GGUF file names', () => {
    expect(quantOf('qwen2.5-1.5b-instruct-q4_k_m.gguf')).toBe('Q4_K_M');
    expect(quantOf('Model-IQ3_XS.gguf')).toBe('IQ3_XS');
    expect(quantOf('model-f16.gguf')).toBe('F16');
    expect(quantOf('README.md')).toBeNull();
  });

  it('turns HF search hits into GGUF-only catalog rows with a fit verdict', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('?search=')) {
          return new Response(
            JSON.stringify([{ id: 'acme/good' }, { id: 'acme/split' }, { id: 'bad id' }]),
          );
        }
        if (url.includes('/acme/good?')) {
          return new Response(
            JSON.stringify({
              id: 'acme/good',
              downloads: 1234,
              gated: false,
              tags: ['license:apache-2.0'],
              gguf: { context_length: 32768 },
              siblings: [
                { rfilename: 'good-Q8_0.gguf', size: 4 * GIB },
                { rfilename: 'good-Q4_K_M.gguf', size: 2 * GIB },
                { rfilename: 'good-00001-of-00002.gguf', size: 1 * GIB },
              ],
            }),
          );
        }
        if (url.includes('/acme/split?')) {
          return new Response(
            JSON.stringify({
              id: 'acme/split',
              siblings: [{ rfilename: 'split-00001-of-00002.gguf', size: 1 * GIB }],
            }),
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const results = await searchHuggingFace('qwen instruct', 'generation', HARDWARE);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'acme/good',
      runtimeModel: 'hf.co/acme/good:Q4_K_M',
      sizeBytes: 2 * GIB,
      fit: 'fits',
      license: 'apache-2.0',
      gated: false,
      downloads: 1234,
      contextLength: 32768,
      source: 'huggingface',
    });
    expect(calls.every((url) => url.startsWith('https://huggingface.co/api/models'))).toBe(true);
    expect(calls[0]).toContain('filter=gguf');
    expect(calls[0]).toContain('pipeline_tag=text-generation');
  });

  it('labels fit against the memory budget', () => {
    expect(fitFor(1 * GIB, 8 * GIB)).toBe('fits');
    expect(fitFor(5.5 * GIB, 8 * GIB)).toBe('tight');
    expect(fitFor(9 * GIB, 8 * GIB)).toBe('too-large');
    expect(fitFor(null, 8 * GIB)).toBe('unknown');
  });

  it('budgets VRAM on CUDA and a share of RAM otherwise', () => {
    expect(
      modelBudget(16 * GIB, { kind: 'cuda', name: 'x', memoryBytes: 24 * GIB }, false).tier,
    ).toBe('large');
    expect(modelBudget(16 * GIB, null, true)).toMatchObject({ tier: 'medium' });
    expect(modelBudget(8 * GIB, null, false)).toMatchObject({ tier: 'small' });
  });

  it('only forwards plain search text to Hugging Face', () => {
    expect(SEARCH_QUERY.test('qwen2.5 instruct')).toBe(true);
    expect(SEARCH_QUERY.test('a&b=c')).toBe(false);
    expect(SEARCH_QUERY.test('https://evil.example/?x')).toBe(false);
  });
});
