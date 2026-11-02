/**
 * Authenticated fetch for the web host. Every failure is typed with the shared
 * error envelope (10C): callers branch on `ok`, and a failed request is never
 * mistaken for an empty list.
 */
import { ErrorEnvelopeSchema } from '@triageai/contracts';
import type { ErrorEnvelope } from '@triageai/contracts';

export interface StoredSession {
  accessToken: string;
  /** Optional only for tests; the browser refresh token is an HttpOnly cookie. */
  refreshToken?: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  user: { id: string; email: string; name: string; role: 'customer' | 'agent' | 'admin' };
}

const STORAGE_KEY = 'triageai.session';

export function getSession(): StoredSession | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function setSession(session: StoredSession): void {
  // Never persist the long-lived refresh token: it lives in the HttpOnly cookie (R10).
  const { refreshToken: _refreshToken, ...safe } = session;
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(safe));
}

export function clearSession(): void {
  globalThis.localStorage?.removeItem(STORAGE_KEY);
}

let refreshInFlight: Promise<StoredSession | null> | null = null;

async function refreshSession(): Promise<StoredSession | null> {
  const session = getSession();
  if (!session) return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
          credentials: 'same-origin',
        });
        if (!res.ok) return null;
        const next = (await res.json()) as StoredSession;
        setSession(next);
        return next;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

function withAuthorization(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${token}`);
  return { ...init, headers };
}

export interface ApiFailure {
  status: number;
  envelope: ErrorEnvelope;
}

export type ApiResult<T> =
  { ok: true; data: T; response: Response } | { ok: false; error: ApiFailure };

function categoryForStatus(status: number): ErrorEnvelope['category'] {
  if (status === 0) return 'dependency_unavailable';
  if (status === 400 || status === 422) return 'validation';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'dependency_unavailable';
  if (status === 504) return 'timeout';
  return status >= 500 ? 'internal' : 'validation';
}

function fallbackEnvelope(status: number, correlationId: string): ErrorEnvelope {
  const category = categoryForStatus(status);
  const userMessage =
    status === 429
      ? 'Too many requests. Wait a moment and try again.'
      : status === 401
        ? 'Please sign in again.'
        : status === 0
          ? 'You appear to be offline. Check your connection and retry.'
          : 'The request failed. Try again.';
  return {
    type: `https://triageai.dev/errors/HTTP_${status}`,
    title: `HTTP_${status}`,
    status,
    code: `HTTP_${status}`,
    category,
    retryable: category === 'rate_limited' || category === 'dependency_unavailable',
    userMessage,
    correlationId,
  };
}

async function readEnvelope(response: Response): Promise<ErrorEnvelope> {
  const correlationId =
    response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? 'unknown';
  try {
    const body = (await response.clone().json()) as unknown;
    return ErrorEnvelopeSchema.parse(body);
  } catch {
    return fallbackEnvelope(response.status, correlationId);
  }
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function signedOut(): void {
  clearSession();
  globalThis.dispatchEvent?.(new Event('triageai:signed-out'));
}

/** Same auth/refresh/error handling as `apiFetch`, but keeps the response body for SSE. */
export async function apiStream(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ApiResult<Response>> {
  const session = getSession();
  let response: Response;
  try {
    response = session?.accessToken
      ? await fetch(input, withAuthorization(init, session.accessToken))
      : await fetch(input, init);
  } catch {
    return { ok: false, error: { status: 0, envelope: fallbackEnvelope(0, 'offline') } };
  }
  if (response.status === 401 && session && !urlOf(input).includes('/api/v1/auth/')) {
    const refreshed = await refreshSession();
    if (!refreshed) {
      signedOut();
    } else {
      try {
        response = await fetch(input, withAuthorization(init, refreshed.accessToken));
      } catch {
        return { ok: false, error: { status: 0, envelope: fallbackEnvelope(0, 'offline') } };
      }
    }
  } else if (response.status === 401) {
    signedOut();
  }
  if (!response.ok) {
    return {
      ok: false,
      error: { status: response.status, envelope: await readEnvelope(response) },
    };
  }
  return { ok: true, data: response, response };
}

export async function apiFetch<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  const session = getSession();
  let response: Response;
  try {
    response = session?.accessToken
      ? await fetch(input, withAuthorization(init, session.accessToken))
      : await fetch(input, init);
  } catch {
    return { ok: false, error: { status: 0, envelope: fallbackEnvelope(0, 'offline') } };
  }

  if (response.status === 401 && session && !urlOf(input).includes('/api/v1/auth/')) {
    const refreshed = await refreshSession();
    if (!refreshed) {
      signedOut();
    } else {
      try {
        response = await fetch(input, withAuthorization(init, refreshed.accessToken));
      } catch {
        return { ok: false, error: { status: 0, envelope: fallbackEnvelope(0, 'offline') } };
      }
    }
  } else if (response.status === 401) {
    signedOut();
  }

  if (!response.ok) {
    return {
      ok: false,
      error: { status: response.status, envelope: await readEnvelope(response) },
    };
  }

  const text = await response.text();
  let data: unknown = undefined;
  if (text.length > 0) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        error: {
          status: response.status,
          envelope: {
            ...fallbackEnvelope(502, 'invalid-response'),
            code: 'HTTP_INVALID_RESPONSE',
            title: 'HTTP_INVALID_RESPONSE',
            category: 'dependency_unavailable',
            retryable: true,
            userMessage: 'The server returned an unreadable response.',
          },
        },
      };
    }
  }
  return { ok: true, data: data as T, response };
}
