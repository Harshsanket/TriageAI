import { useEffect, useState } from 'react';

import { Notice } from './index';

/** Offline is a state, not an empty result (10C.T7). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine ?? true);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    globalThis.addEventListener?.('online', up);
    globalThis.addEventListener?.('offline', down);
    return () => {
      globalThis.removeEventListener?.('online', up);
      globalThis.removeEventListener?.('offline', down);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="ui-offline" role="status">
      <Notice tone="warning">
        You are offline. Changes will not be saved until the connection returns.
      </Notice>
    </div>
  );
}
