/**
 * Authenticated fetch for the web host. When auth is disabled the server never
 * asks for a token; when it is required the access token is attached and a
 * single refresh is attempted on 401 (FR-11.1).
 */
export interface StoredSession {
  accessToken: string;
  refreshToken: string;
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
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  globalThis.localStorage?.removeItem(STORAGE_KEY);
}

let refreshInFlight: Promise<StoredSession | null> | null = null;

async function refreshSession(): Promise<StoredSession | null> {
  const session = getSession();
  if (!session?.refreshToken) return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
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

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const session = getSession();
  const first = session?.accessToken
    ? await fetch(input, withAuthorization(init, session.accessToken))
    : await fetch(input, init);
  if (first.status !== 401 || !session?.refreshToken) return first;

  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/v1/auth/')) return first;

  const refreshed = await refreshSession();
  if (!refreshed) {
    clearSession();
    return first;
  }
  return fetch(input, withAuthorization(init, refreshed.accessToken));
}
