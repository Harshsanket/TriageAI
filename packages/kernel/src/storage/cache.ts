/** Cache capability (Phase 18.7): in-process LRU by default, Redis for multi-node. */
import { Redis } from 'ioredis';

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Drop every entry. KB source changes call this so cached retrieval results
   * (and answers generated from them) cannot outlive an Off switch.
   */
  clear?(): Promise<void> | void;
  /** Process-local hit/miss counters; `size` is only meaningful for local caches. */
  stats?(): CacheStats;
  /** Release backing connections (Redis). Hosts call this on shutdown. */
  close?(): Promise<void> | void;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  size?: number;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries = 1_000) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // Touch for LRU ordering.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  stats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.entries.size,
      hitRate: total === 0 ? 1 : this.hits / total,
    };
  }
}

const NAMESPACE_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface RedisCacheOptions {
  /** Redis connection URL (`redis://…`). */
  url: string;
  /** Key namespace; every key becomes `<namespace>:<key>`. */
  namespace?: string;
}

/**
 * Redis-backed Cache (18.T11). Values are JSON, TTLs are set with `PX`, and
 * `clear()` only touches this namespace (SCAN + UNLINK) — it never runs
 * FLUSHDB/FLUSHALL, so two caches can share one Redis.
 */
export class RedisCache implements Cache {
  private readonly redis: Redis;
  private readonly prefix: string;
  private hits = 0;
  private misses = 0;

  constructor(options: RedisCacheOptions) {
    const namespace = (options.namespace ?? 'triageai:cache').replace(/:+$/, '');
    if (namespace.length === 0 || !NAMESPACE_PATTERN.test(namespace)) {
      throw new Error(`unsafe cache namespace "${namespace}"`);
    }
    this.prefix = `${namespace}:`;
    this.redis = new Redis(options.url, {
      // Connect on the first command: constructing a capability must not open
      // sockets (tests and `--help` style boots build capabilities eagerly).
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      retryStrategy: (attempts) => Math.min(attempts * 200, 2_000),
    });
    // ioredis emits 'error' on connection failures; without a listener Node
    // treats it as unhandled. Commands still reject, so callers see the error.
    this.redis.on('error', () => undefined);
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const payload = await this.redis.get(this.key(key));
    if (payload === null) {
      this.misses += 1;
      return undefined;
    }
    try {
      const value = JSON.parse(payload) as T;
      this.hits += 1;
      return value;
    } catch {
      // A foreign/corrupt payload is a miss, not a failed request; drop it so
      // the next set() starts clean.
      await this.redis.unlink(this.key(key));
      this.misses += 1;
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const payload = JSON.stringify(value);
    if (payload === undefined) throw new Error('cache values must be JSON-serialisable');
    const ttl = Math.max(1, Math.floor(ttlMs));
    await this.redis.set(this.key(key), payload, 'PX', ttl);
  }

  async delete(key: string): Promise<void> {
    await this.redis.unlink(this.key(key));
  }

  /** SCAN/UNLINK inside this namespace only; safe beside other Redis users. */
  async clear(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 500);
      cursor = next;
      // Belt and braces: never unlink a key outside our prefix, even if the
      // MATCH pattern were to over-match.
      const scoped = keys.filter((key) => key.startsWith(this.prefix));
      if (scoped.length > 0) await this.redis.unlink(...scoped);
    } while (cursor !== '0');
  }

  stats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 1 : this.hits / total,
    };
  }

  async close(): Promise<void> {
    if (this.redis.status === 'end') return;
    // lazyConnect leaves the client in `wait`; quit() would open a connection
    // just to close it, which can hang shutdown when Redis is unreachable.
    if (this.redis.status === 'wait') {
      this.redis.disconnect();
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
