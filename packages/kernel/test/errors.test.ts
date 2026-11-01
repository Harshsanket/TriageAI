import { describe, expect, it } from 'vitest';

import { ErrorEnvelopeSchema } from '@triageai/contracts';

import {
  AppError,
  bootValidationError,
  configInvalid,
  conflict,
  dependencyUnavailable,
  internal,
  invalid,
  notFound,
  policyBlocked,
  rateLimited,
  timeout,
} from '../src/errors.js';

describe('kernel error factories (phase 10c)', () => {
  const cases: Array<{
    name: string;
    error: AppError;
    code: string;
    status: number;
    category: string;
    retryable: boolean;
  }> = [
    {
      name: 'notFound',
      error: notFound('ticket missing'),
      code: 'NOT_FOUND',
      status: 404,
      category: 'not_found',
      retryable: false,
    },
    {
      name: 'conflict',
      error: conflict('already exists'),
      code: 'CONFLICT',
      status: 409,
      category: 'conflict',
      retryable: false,
    },
    {
      name: 'invalid',
      error: invalid('bad input'),
      code: 'VALIDATION_ERROR',
      status: 400,
      category: 'validation',
      retryable: false,
    },
    {
      name: 'dependencyUnavailable',
      error: dependencyUnavailable(new Error('ai-service down')),
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
      category: 'dependency_unavailable',
      retryable: true,
    },
    {
      name: 'timeout',
      error: timeout(),
      code: 'TIMEOUT',
      status: 504,
      category: 'timeout',
      retryable: true,
    },
    {
      name: 'rateLimited',
      error: rateLimited(1500),
      code: 'RATE_LIMITED',
      status: 429,
      category: 'rate_limited',
      retryable: true,
    },
    {
      name: 'policyBlocked',
      error: policyBlocked('blocked by policy'),
      code: 'POLICY_BLOCKED',
      status: 403,
      category: 'policy_blocked',
      retryable: false,
    },
    {
      name: 'internal',
      error: internal('missing adapter'),
      code: 'INTERNAL_ERROR',
      status: 500,
      category: 'internal',
      retryable: false,
    },
    {
      name: 'bootValidationError',
      error: bootValidationError('boot failed', ['missing module']),
      code: 'kernel.BOOT_VALIDATION_FAILED',
      status: 500,
      category: 'internal',
      retryable: false,
    },
    {
      name: 'configInvalid',
      error: configInvalid('bad config'),
      code: 'kernel.CONFIG_INVALID',
      status: 422,
      category: 'validation',
      retryable: false,
    },
  ];

  it('sets code, status, category and retryable on every factory', () => {
    for (const testCase of cases) {
      expect(testCase.error.code, testCase.name).toBe(testCase.code);
      expect(testCase.error.statusCode, testCase.name).toBe(testCase.status);
      expect(testCase.error.category, testCase.name).toBe(testCase.category);
      expect(testCase.error.retryable, testCase.name).toBe(testCase.retryable);
      expect(testCase.error.userMessage.length, testCase.name).toBeGreaterThan(0);
    }
  });

  it('produces a parseable envelope for every factory', () => {
    for (const testCase of cases) {
      const envelope = testCase.error.toEnvelope('req-1');
      expect(ErrorEnvelopeSchema.parse(envelope), testCase.name).toMatchObject({
        type: `https://triageai.dev/errors/${testCase.code}`,
        title: testCase.code,
        code: testCase.code,
        status: testCase.status,
        category: testCase.category,
        retryable: testCase.retryable,
        correlationId: 'req-1',
      });
    }
  });

  it('keeps retry-after only when supplied', () => {
    expect(rateLimited(1500).toEnvelope('req-1').retryAfterMs).toBe(1500);
    expect(rateLimited().toEnvelope('req-1').retryAfterMs).toBeUndefined();
    expect(timeout().toEnvelope('req-1').retryAfterMs).toBeUndefined();
  });

  it('keeps the cause chain server-side and a safe user message', () => {
    const cause = new Error('ECONNREFUSED 127.0.0.1:8000');
    const error = dependencyUnavailable(cause);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('ECONNREFUSED');
    expect(error.userMessage).not.toContain('ECONNREFUSED');
  });

  it('infers category and retryability from a code or status', () => {
    const notFoundError = new AppError('support.TICKET_NOT_FOUND', 'missing', undefined, 404);
    expect(notFoundError.category).toBe('not_found');
    expect(notFoundError.retryable).toBe(false);

    const timeoutError = new AppError('ollama.TIMEOUT', 'slow', undefined, 504);
    expect(timeoutError.category).toBe('timeout');
    expect(timeoutError.retryable).toBe(true);

    const unavailable = new AppError('ai-service.503', 'down', undefined, 503);
    expect(unavailable.category).toBe('dependency_unavailable');
    expect(unavailable.retryable).toBe(true);

    const unknown = new AppError('something.ODD', 'boom', undefined, 418);
    expect(unknown.category).toBe('internal');
    expect(unknown.retryable).toBe(false);
  });

  it('uses a generic user message for 5xx errors', () => {
    const error = new AppError('something.BROKE', 'SQLSTATE 42P01 at /secret/path');
    expect(error.userMessage).not.toContain('SQLSTATE');
    expect(error.toEnvelope('req-1').detail).toContain('SQLSTATE');
  });
});
