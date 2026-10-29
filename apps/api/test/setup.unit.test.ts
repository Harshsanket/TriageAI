import { describe, expect, it } from 'vitest';

import { SetupAnswersSchema } from '@triageai/contracts';
import { parseConfigFile } from '@triageai/kernel';

import { MODULES } from '../src/app.js';
import { fitFor, quantOf, SEARCH_QUERY } from '../src/setup/catalog.js';
import { modelBudget } from '../src/setup/hardware.js';
import { planSetup } from '../src/setup/plan.js';

const GIB = 1024 ** 3;
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
