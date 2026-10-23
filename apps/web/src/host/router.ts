import { useEffect, useState } from 'react';

/**
 * Tiny dependency-free router (hash-free pushState). Phase 1 scope: paths like
 * `/echo` and `/chat` plus `/` home. External router deps were declined
 * (ADR-0007: host owns navigation, modules own their pages).
 */
export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}
