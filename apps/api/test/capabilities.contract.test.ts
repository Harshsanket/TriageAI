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

describe('embedding cache (phase 19.3)', () => {
  it('reuses vectors for repeated texts and only sends the uncached ones', async () => {
    let calls = 0;
    const bodies: string[][] = [];
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { texts?: string[] };
      const texts = body.texts ?? [];
      bodies.push(texts);
      return new Response(
        JSON.stringify({ vectors: texts.map(() => [1, 2]), modelVersion: 'fake-embed' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const embedder = new HttpEmbedder('http://ai.test', fetchMock);

    const first = await embedder.embed(['alpha', 'beta']);
    expect(first.vectors).toEqual([
      [1, 2],
      [1, 2],
    ]);
    expect(calls).toBe(1);

    const second = await embedder.embed(['alpha', 'beta']);
    expect(second.modelVersion).toBe('fake-embed');
    expect(calls).toBe(1);
    expect(embedder.stats()).toMatchObject({ hits: 2, misses: 2, hitRate: 0.5 });

    await embedder.embed(['alpha', 'gamma']);
    expect(calls).toBe(2);
    expect(bodies[1]).toEqual(['gamma']);
    expect(embedder.stats().hits).toBe(3);
  });
});

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
