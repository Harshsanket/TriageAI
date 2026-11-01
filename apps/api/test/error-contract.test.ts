import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { AppError } from '@triageai/kernel';
import { ErrorEnvelopeSchema } from '@triageai/contracts';

import { buildApp } from '../src/app.js';

const ADMIN = {
  userId: 'admin-1',
  email: 'admin@test.dev',
  role: 'admin' as const,
  sessionId: null,
  authenticated: true,
};

describe('error envelope at the API boundary (phase 10c)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ quiet: true, skipBoot: true });

    app.get('/__errors/typed', async () => {
      throw new AppError('support.TICKET_NOT_FOUND', 'ticket 42 missing', { ticketId: '42' }, 404);
    });
    app.get('/__errors/admin', async (request) => {
      request.principal = ADMIN;
      throw new AppError('support.TICKET_NOT_FOUND', 'ticket 42 missing', { ticketId: '42' }, 404);
    });
    app.get('/__errors/boom', async () => {
      throw new Error('SQLSTATE 42P01 at /secret');
    });
    app.post('/__errors/zod', async (request) => {
      z.object({ name: z.string().min(1) }).parse(request.body);
      return { ok: true };
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const envelope = (body: unknown) => ErrorEnvelopeSchema.parse(body);

  it('returns the envelope for AppError and strips detail for non-admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/__errors/typed' });
    expect(res.statusCode).toBe(404);
    const body = envelope(res.json());
    expect(body).toMatchObject({
      code: 'support.TICKET_NOT_FOUND',
      title: 'support.TICKET_NOT_FOUND',
      status: 404,
      category: 'not_found',
      retryable: false,
      userMessage: 'ticket 42 missing',
    });
    expect(body.detail).toBeUndefined();
    expect(body.correlationId.length).toBeGreaterThan(0);
    expect((res.json() as { details?: unknown }).details).toEqual({ ticketId: '42' });
  });

  it('keeps operator detail for admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/__errors/admin' });
    expect(res.statusCode).toBe(404);
    expect(envelope(res.json()).detail).toBe('ticket 42 missing');
  });

  it('wraps zod validation failures', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__errors/zod',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const parsed = envelope(res.json());
    expect(parsed).toMatchObject({ category: 'validation', retryable: false });
    expect((res.json() as { details?: unknown }).details).toEqual(expect.any(Array));
    expect(parsed.detail).toBeUndefined();
  });

  it('wraps malformed JSON as a validation envelope', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__errors/zod',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(envelope(res.json())).toMatchObject({
      code: 'INVALID_JSON',
      category: 'validation',
      retryable: false,
    });
  });

  it('wraps unknown routes as not_found', async () => {
    const res = await app.inject({ method: 'GET', url: '/__errors/missing' });
    expect(res.statusCode).toBe(404);
    expect(envelope(res.json())).toMatchObject({
      code: 'NOT_FOUND',
      category: 'not_found',
      retryable: false,
    });
  });

  it('hides internal error messages and stack data from non-admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/__errors/boom' });
    expect(res.statusCode).toBe(500);
    const parsed = envelope(res.json());
    expect(parsed).toMatchObject({
      code: 'INTERNAL_ERROR',
      category: 'internal',
      retryable: false,
    });
    expect(parsed.detail).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toContain('SQLSTATE');
    expect(JSON.stringify(res.json())).not.toContain('/secret');
  });
});
