/** Cache capability (Phase 18.7): in-process LRU by default; Redis later. */
export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Drop every entry. KB source changes call this so cached retrieval results
   * (and answers generated from them) cannot outlive an Off switch.
   */
  clear?(): Promise<void> | void;
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
