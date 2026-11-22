/**
 * 18.T11: Fastify rate-limit store backed by the Cache capability. Redis uses
 * INCR+PEXPIRE atomically, so two API instances share one window; the lazy
 * static binding keeps the plugin's registration order (it registers before
 * the first kernel generation) while the capability is resolved at boot.
 */
import type { Cache } from '@triageai/kernel';

interface Counter {
  count: number;
  expiresAt: number;
}

export class CacheRateLimitStore {
  private static cache: Cache | null = null;
  private static readonly fallback = new Map<string, Counter>();

  constructor(_options?: unknown) {}

  static setCache(cache: Cache | undefined | null): void {
    CacheRateLimitStore.cache = cache ?? null;
  }

  child(): CacheRateLimitStore {
    return this;
  }

  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindow: number,
  ): void {
    const cache = CacheRateLimitStore.cache;
    if (cache?.increment) {
      cache
        .increment(`ratelimit:${key}`, timeWindow)
        .then((result) => callback(null, { current: result.count, ttl: result.ttlMs }))
        .catch((error: unknown) => callback(error as Error));
      return;
    }
    const now = Date.now();
    const current = CacheRateLimitStore.fallback.get(key);
    if (!current || current.expiresAt <= now) {
      const ttl = Math.max(1, timeWindow);
      CacheRateLimitStore.fallback.set(key, { count: 1, expiresAt: now + ttl });
      callback(null, { current: 1, ttl });
      return;
    }
    current.count += 1;
    callback(null, { current: current.count, ttl: Math.max(0, current.expiresAt - now) });
  }
}
