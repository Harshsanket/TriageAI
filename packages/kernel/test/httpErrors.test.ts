import { describe, expect, it } from 'vitest';

import { fetchFailure, httpFailure, parseRetryAfterMs } from '../src/errors.js';
import { requestWithRetry } from '../src/outputChannel/http.js';

type Step =
  { status: number; headers?: Record<string, string>; body?: string } | { error: unknown };

function fetchSequence(steps: Step[]): { fetch: typeof fetch; calls: () => number } {
  let index = 0;
  const fetchImpl = (async () => {
    const step = steps[Math.min(index, steps.length - 1)] as Step;
    index += 1;
    if ('error' in step) throw step.error;
    return new Response(step.body ?? '', {
      status: step.status,
      headers: step.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls: () => index };
}

describe('HTTP failure classification (phase 10c)', () => {
  it('parses Retry-After seconds, HTTP dates and garbage', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0.5')).toBe(500);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    expect(parseRetryAfterMs(inTwoSeconds)).toBeGreaterThan(1_000);
  });

  it('maps HTTP statuses to the error taxonomy', () => {
    const failure = (status: number, retryAfter?: string) =>
      httpFailure({ codePrefix: 'test', label: 'dependency', status, retryAfter });

    expect(failure(408)).toMatchObject({
      code: 'test.TIMEOUT',
      statusCode: 504,
      category: 'timeout',
      retryable: true,
    });
    expect(failure(429, '3')).toMatchObject({
      code: 'test.RATE_LIMITED',
      statusCode: 429,
      category: 'rate_limited',
      retryable: true,
      retryAfterMs: 3000,
    });
    expect(failure(503)).toMatchObject({
      code: 'test.UNAVAILABLE',
      statusCode: 502,
      category: 'dependency_unavailable',
      retryable: true,
    });
    expect(failure(401)).toMatchObject({ category: 'unauthenticated', retryable: false });
    expect(failure(403)).toMatchObject({ category: 'forbidden', retryable: false });
    expect(failure(404)).toMatchObject({ category: 'not_found', retryable: false });
    expect(failure(409)).toMatchObject({ category: 'conflict', retryable: false });
    expect(failure(400)).toMatchObject({
      code: 'test.INVALID',
      statusCode: 502,
      category: 'validation',
      retryable: false,
    });
    expect(failure(422)).toMatchObject({ category: 'validation', retryable: false });
  });

  it('classifies timeouts and network failures as retryable', () => {
    expect(
      fetchFailure({
        codePrefix: 'test',
        label: 'dependency',
        cause: new DOMException('timed out', 'TimeoutError'),
      }),
    ).toMatchObject({ code: 'test.TIMEOUT', category: 'timeout', retryable: true });
    expect(
      fetchFailure({
        codePrefix: 'test',
        label: 'dependency',
        cause: new TypeError('fetch failed: ECONNREFUSED'),
      }),
    ).toMatchObject({
      code: 'test.UNAVAILABLE',
      category: 'dependency_unavailable',
      retryable: true,
    });
  });

  it('honours Retry-After when retrying a 429', async () => {
    const sleeps: number[] = [];
    const fetchImpl = fetchSequence([{ status: 429, headers: { 'retry-after': '2' } }]);
    const error = await requestWithRetry({
      url: 'http://dependency.test',
      fetchImpl: fetchImpl.fetch,
      maxAttempts: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).catch((err: unknown) => err);

    expect(sleeps).toEqual([2000]);
    expect(error).toMatchObject({
      code: 'integration.RATE_LIMITED',
      statusCode: 429,
      category: 'rate_limited',
      retryable: true,
      retryAfterMs: 2000,
    });
  });

  it('retries 408 and 5xx, then succeeds', async () => {
    for (const status of [408, 503]) {
      const fetchImpl = fetchSequence([{ status }, { status: 200, body: '{"ok":true}' }]);
      const response = await requestWithRetry({
        url: 'http://dependency.test',
        fetchImpl: fetchImpl.fetch,
        maxAttempts: 2,
        sleep: async () => undefined,
      });
      expect(response.body).toEqual({ ok: true });
    }
  });

  it('classifies an exhausted 5xx as dependency_unavailable', async () => {
    const fetchImpl = fetchSequence([{ status: 500 }]);
    const error = await requestWithRetry({
      url: 'http://dependency.test',
      fetchImpl: fetchImpl.fetch,
      maxAttempts: 2,
      sleep: async () => undefined,
    }).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'integration.UNAVAILABLE',
      statusCode: 502,
      category: 'dependency_unavailable',
      retryable: true,
    });
  });

  it('classifies an exhausted 408 as timeout', async () => {
    const fetchImpl = fetchSequence([{ status: 408 }]);
    const error = await requestWithRetry({
      url: 'http://dependency.test',
      fetchImpl: fetchImpl.fetch,
      maxAttempts: 2,
      sleep: async () => undefined,
    }).catch((err: unknown) => err);
    expect(error).toMatchObject({ category: 'timeout', retryable: true, statusCode: 504 });
  });

  it('does not retry a permanent 4xx', async () => {
    const fetchImpl = fetchSequence([{ status: 400 }, { status: 200 }]);
    const sleeps: number[] = [];
    const error = await requestWithRetry({
      url: 'http://dependency.test',
      fetchImpl: fetchImpl.fetch,
      maxAttempts: 4,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    }).catch((err: unknown) => err);
    expect(fetchImpl.calls()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(error).toMatchObject({ category: 'validation', retryable: false });
  });

  it('keeps 5xx classification when retries are disabled', async () => {
    const fetchImpl = fetchSequence([{ status: 500 }, { status: 200 }]);
    const error = await requestWithRetry({
      url: 'http://dependency.test',
      fetchImpl: fetchImpl.fetch,
      maxAttempts: 4,
      retryServerErrors: false,
      sleep: async () => undefined,
    }).catch((err: unknown) => err);
    expect(fetchImpl.calls()).toBe(1);
    expect(error).toMatchObject({ category: 'dependency_unavailable', retryable: true });
  });

  it('classifies a fetch timeout as retryable', async () => {
    const fetchImpl = fetchSequence([
      { error: new DOMException('The operation timed out', 'TimeoutError') },
    ]);
    const error = await requestWithRetry({
      url: 'http://dependency.test',
      fetchImpl: fetchImpl.fetch,
      maxAttempts: 2,
      sleep: async () => undefined,
    }).catch((err: unknown) => err);
    expect(error).toMatchObject({
      code: 'integration.TIMEOUT',
      statusCode: 504,
      category: 'timeout',
      retryable: true,
    });
  });

  it('retries network failures and classifies them', async () => {
    const fetchImpl = fetchSequence([{ error: new TypeError('fetch failed: ECONNREFUSED') }]);
    const error = await requestWithRetry({
      url: 'http://dependency.test',
      fetchImpl: fetchImpl.fetch,
      maxAttempts: 2,
      sleep: async () => undefined,
    }).catch((err: unknown) => err);
    expect(fetchImpl.calls()).toBe(2);
    expect(error).toMatchObject({
      code: 'integration.UNAVAILABLE',
      category: 'dependency_unavailable',
      retryable: true,
    });
  });
});
