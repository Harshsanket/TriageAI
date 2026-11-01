import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, clearSession, getSession, setSession } from './api';

const session = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  user: { id: 'u1', email: 'a@b.c', name: 'A', role: 'admin' as const },
};

const envelope = (status: number, code: string, userMessage: string) => ({
  type: `https://triageai.dev/errors/${code}`,
  title: code,
  status,
  code,
  category: status === 429 ? 'rate_limited' : status === 401 ? 'unauthenticated' : 'internal',
  retryable: status === 429,
  userMessage,
  correlationId: 'req-1',
});

beforeEach(() => {
  clearSession();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSession();
});

describe('typed apiFetch (phase 10c)', () => {
  it('returns typed data on success', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await apiFetch<{ hello: string }>('/api/v1/x');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.hello).toBe('world');
  });

  it('surfaces the error envelope instead of pretending the list is empty', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(envelope(500, 'INTERNAL_ERROR', 'Server exploded')), {
          status: 500,
        }),
    ) as unknown as typeof fetch;
    const result = await apiFetch('/api/v1/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.envelope.userMessage).toBe('Server exploded');
      expect(result.error.envelope.correlationId).toBe('req-1');
    }
  });

  it('refreshes once on 401 and retries the request', async () => {
    setSession(session);
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/auth/refresh')) {
        return new Response(JSON.stringify({ ...session, accessToken: 'access-2' }), {
          status: 200,
        });
      }
      const auth = calls.filter((call) => call === '/api/v1/me').length;
      if (auth === 1)
        return new Response(JSON.stringify(envelope(401, 'UNAUTH', 'Sign in')), { status: 401 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await apiFetch<{ ok: boolean }>('/api/v1/me');
    expect(result.ok).toBe(true);
    expect(calls).toEqual(['/api/v1/me', '/api/v1/auth/refresh', '/api/v1/me']);
    expect(getSession()?.accessToken).toBe('access-2');
  });

  it('signs out when refresh fails and dispatches the shell event', async () => {
    setSession(session);
    const signedOut = vi.fn();
    globalThis.addEventListener('triageai:signed-out', signedOut);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/auth/refresh')) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify(envelope(401, 'UNAUTH', 'Sign in')), { status: 401 });
    }) as unknown as typeof fetch;

    const result = await apiFetch('/api/v1/me');
    expect(result.ok).toBe(false);
    expect(getSession()).toBeNull();
    expect(signedOut).toHaveBeenCalled();
    globalThis.removeEventListener('triageai:signed-out', signedOut);
  });

  it('reports an offline failure as a typed error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const result = await apiFetch('/api/v1/x');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(0);
      expect(result.error.envelope.userMessage).toMatch(/offline/i);
      expect(result.error.envelope.category).toBe('dependency_unavailable');
    }
  });
});
