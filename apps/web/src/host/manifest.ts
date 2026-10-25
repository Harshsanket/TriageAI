import { useEffect, useState } from 'react';

import type { SystemManifest } from '@triageai/contracts';
import { SystemManifestSchema } from '@triageai/contracts';

import { apiFetch } from './api';

export type ManifestState =
  | { phase: 'loading' }
  | { phase: 'ready'; manifest: SystemManifest }
  | { phase: 'unauthenticated' }
  | { phase: 'error'; message: string };

const POLL_INTERVAL_MS = 30_000;

/** Fetches (and lightly refreshes) the kernel system manifest — the only
 * cross-module contract the host depends on (ADR-0007). */
export function useSystemManifest(): ManifestState {
  const [state, setState] = useState<ManifestState>({ phase: 'loading' });

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const res = await apiFetch('/api/v1/system/manifest');
        if (res.status === 401) {
          if (!disposed) setState({ phase: 'unauthenticated' });
          return;
        }
        if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
        const parsed = SystemManifestSchema.parse(await res.json());
        if (!disposed) setState({ phase: 'ready', manifest: parsed });
      } catch (err) {
        if (!disposed) setState({ phase: 'error', message: (err as Error).message });
      }
    };
    void load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return state;
}

export function enabledModuleIds(manifest: SystemManifest): string[] {
  return manifest.modules.map((m) => m.id);
}

export function navEntries(
  manifest: SystemManifest,
): Array<{ label: string; path: string; order: number }> {
  return manifest.modules.flatMap((m) => m.manifest.nav).sort((a, b) => a.order - b.order);
}
