import { describe, expect, it } from 'vitest';

import {
  HttpClassifier,
  HttpEmbedder,
  OllamaGenerator,
  OpenAICompatibleGenerator,
} from '../src/services/capabilities.js';

const jsonHeaders = { 'content-type': 'application/json' };

function fail(status: number, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ error: 'scripted failure' }), {
      status,
      headers: { ...jsonHeaders, ...headers },
    })) as unknown as typeof fetch;
}

function throwFetch(error: unknown): typeof fetch {
  return (async () => {
    throw error;
  }) as unknown as typeof fetch;
}

describe('capability adapter failure classification (phase 10c)', () => {
  it('classifies ai-service rate limits and preserves Retry-After', async () => {
    const embedder = new HttpEmbedder('http://ai.test', fail(429, { 'retry-after': '2' }));
    await expect(embedder.embed(['hello'])).rejects.toMatchObject({
      code: 'ai.RATE_LIMITED',
      statusCode: 429,
      category: 'rate_limited',
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it('classifies ai-service 408, 5xx and 4xx responses', async () => {
    const timeout = new HttpClassifier('http://ai.test', undefined, fail(408));
    await expect(timeout.classify('hi')).rejects.toMatchObject({
      code: 'ai.TIMEOUT',
      statusCode: 504,
      category: 'timeout',
      retryable: true,
    });

    const unavailable = new HttpClassifier('http://ai.test', undefined, fail(503));
    await expect(unavailable.classify('hi')).rejects.toMatchObject({
      code: 'ai.UNAVAILABLE',
      statusCode: 502,
      category: 'dependency_unavailable',
      retryable: true,
    });

    const invalid = new HttpClassifier('http://ai.test', undefined, fail(422));
    await expect(invalid.classify('hi')).rejects.toMatchObject({
      code: 'ai.INVALID',
      statusCode: 502,
      category: 'validation',
      retryable: false,
    });
  });

  it('classifies a fetch timeout', async () => {
    const embedder = new HttpEmbedder(
      'http://ai.test',
      throwFetch(new DOMException('The operation was aborted', 'TimeoutError')),
    );
    await expect(embedder.embed(['hello'])).rejects.toMatchObject({
      code: 'ai.TIMEOUT',
      statusCode: 504,
      category: 'timeout',
      retryable: true,
    });
  });

  it('classifies Ollama failures', async () => {
    const generator = new OllamaGenerator('http://ollama.test', 'model', fail(503));
    await expect(generator.generate('hi')).rejects.toMatchObject({
      code: 'ollama.UNAVAILABLE',
      category: 'dependency_unavailable',
      retryable: true,
    });

    const invalid = new OllamaGenerator('http://ollama.test', 'model', fail(400));
    await expect(invalid.generate('hi')).rejects.toMatchObject({
      code: 'ollama.INVALID',
      category: 'validation',
      retryable: false,
    });
  });

  it('classifies OpenAI-compatible failures', async () => {
    const generator = new OpenAICompatibleGenerator(
      'http://lmstudio.test/v1',
      'model',
      'local',
      fail(429, { 'retry-after': '0.5' }),
    );
    await expect(generator.generate('hi')).rejects.toMatchObject({
      code: 'lmstudio.RATE_LIMITED',
      category: 'rate_limited',
      retryable: true,
      retryAfterMs: 500,
    });

    const unavailable = new OpenAICompatibleGenerator(
      'http://lmstudio.test/v1',
      'model',
      'local',
      throwFetch(new TypeError('fetch failed: ECONNREFUSED')),
    );
    await expect(unavailable.generate('hi')).rejects.toMatchObject({
      code: 'lmstudio.UNAVAILABLE',
      category: 'dependency_unavailable',
      retryable: true,
    });
  });
});
