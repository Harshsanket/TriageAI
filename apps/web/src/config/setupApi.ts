/**
 * Client side of `/api/v1/setup/*` (ADR-0024). While setup is pending the
 * server only accepts the one-time setup token from its log; afterwards these
 * routes are admin-only and use the normal session.
 */
import { useEffect, useState } from 'react';

import { SetupStatusSchema, type SetupStatus } from '@triageai/contracts';

import { apiFetch } from '../host/api';

const TOKEN_KEY = 'triageai.setupToken';

export function getSetupToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSetupToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode: the token just won't survive a reload.
  }
}

export async function setupFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getSetupToken();
  if (!token) return apiFetch(path, init);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Setup ${token}`);
  return fetch(path, { ...init, headers });
}

export async function setupJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const res = await setupFetch(path, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T & { detail?: string };
  if (!res.ok && res.status !== 422) {
    throw new Error(body.detail ?? `${path} failed (${res.status})`);
  }
  return body;
}

export type SetupStatusState =
  { phase: 'loading' } | { phase: 'ready'; status: SetupStatus; refresh: () => void };

/**
 * Setup status, or `ready` with a complete status when it can't be read: the
 * server's setup gate is the real enforcement, so the web app fails open.
 */
export function useSetupStatus(): SetupStatusState {
  const [state, setState] = useState<SetupStatusState>({ phase: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let disposed = false;
    const refresh = () => setNonce((n) => n + 1);
    void (async () => {
      let status: SetupStatus = {
        state: 'complete',
        tokenRequired: false,
        restartRequired: false,
        lastError: null,
        overlayVersion: null,
        secretStoreAvailable: false,
      };
      try {
        const res = await fetch('/api/v1/setup/status');
        if (res.ok) status = SetupStatusSchema.parse(await res.json());
      } catch {
        // fall through to "complete"
      }
      if (!disposed) setState({ phase: 'ready', status, refresh });
    })();
    return () => {
      disposed = true;
    };
  }, [nonce]);

  return state;
}

export const gib = (bytes: number | null | undefined): string =>
  bytes == null ? '—' : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
