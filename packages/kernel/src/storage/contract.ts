/**
 * Cache + BlobStore capability contract suites (18.T11/T12). Run against every
 * adapter: a replacement must pass the same cases, unchanged
 * (docs/contracts/contract-testing.md §1).
 */
import { expect, it } from 'vitest';

import type { BlobStore } from './blob.js';
import type { Cache } from './cache.js';

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CacheContractFixture {
  cache: Cache;
  /**
   * A second, independent cache instance. For namespaced adapters it must use
   * a different namespace so `clear()` scoping is observable.
   */
  sibling?: Cache;
  dispose?: () => Promise<void> | void;
}

export type CacheContractFactory = () => CacheContractFixture | Promise<CacheContractFixture>;

export function cacheContractSuite(name: string, factory: CacheContractFactory): void {
  it(`${name}: stores JSON values and tracks hits/misses`, async () => {
    const { cache, dispose } = await factory();
    try {
      expect(await cache.get('missing')).toBeUndefined();
      const value = { nested: { list: [1, 'two', true] }, n: 3 };
      await cache.set('key', value, 60_000);
      expect(await cache.get('key')).toEqual(value);
      expect(await cache.get<string>('key')).not.toBe('key');
      const stats = cache.stats?.();
      expect(stats).toMatchObject({ hits: 2, misses: 1, hitRate: 2 / 3 });
    } finally {
      await dispose?.();
    }
  });

  it(`${name}: expires entries after the TTL`, async () => {
    const { cache, dispose } = await factory();
    try {
      await cache.set('short', 'lived', 100);
      expect(await cache.get('short')).toBe('lived');
      await tick(300);
      expect(await cache.get('short')).toBeUndefined();
    } finally {
      await dispose?.();
    }
  });

  it(`${name}: deletes one key and tolerates a missing key`, async () => {
    const { cache, dispose } = await factory();
    try {
      await cache.set('a', 1, 60_000);
      await cache.set('b', 2, 60_000);
      await cache.delete('a');
      expect(await cache.get('a')).toBeUndefined();
      expect(await cache.get('b')).toBe(2);
      await expect(cache.delete('never-written')).resolves.toBeUndefined();
    } finally {
      await dispose?.();
    }
  });

  it(`${name}: clear() drops only this cache's keys`, async () => {
    const { cache, sibling, dispose } = await factory();
    try {
      await cache.set('retrieval:doc', { chunks: ['x'] }, 60_000);
      if (sibling) await sibling.set('retrieval:doc', { chunks: ['other'] }, 60_000);
      await cache.clear?.();
      expect(await cache.get('retrieval:doc')).toBeUndefined();
      if (sibling) expect(await sibling.get('retrieval:doc')).toEqual({ chunks: ['other'] });
    } finally {
      await sibling?.clear?.();
      await dispose?.();
    }
  });
}

export interface BlobStoreContractFixture {
  store: BlobStore;
  dispose?: () => Promise<void> | void;
}

export type BlobStoreContractFactory = () =>
  BlobStoreContractFixture | Promise<BlobStoreContractFixture>;

export function blobStoreContractSuite(name: string, factory: BlobStoreContractFactory): void {
  it(`${name}: is content-addressed and idempotent`, async () => {
    const { store, dispose } = await factory();
    try {
      const bytes = new Uint8Array([0, 1, 2, 250, 255]);
      const first = await store.put(bytes, { contentType: 'application/octet-stream' });
      const second = await store.put(bytes, { contentType: 'text/plain' });
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(first.ref).toBe(`${first.sha256.slice(0, 2)}/${first.sha256}`);
      expect(second.ref).toBe(first.ref);
      expect(first.size).toBe(bytes.byteLength);
      expect(Array.from(await store.get(first.ref))).toEqual(Array.from(bytes));

      const other = await store.put(new TextEncoder().encode('different'), {
        contentType: 'text/plain',
      });
      expect(other.ref).not.toBe(first.ref);
    } finally {
      await dispose?.();
    }
  });

  it(`${name}: delete is idempotent and get() fails after it`, async () => {
    const { store, dispose } = await factory();
    try {
      const { ref } = await store.put(new TextEncoder().encode('hello'), {
        contentType: 'text/plain',
      });
      expect(Buffer.from(await store.get(ref)).toString()).toBe('hello');
      await store.delete(ref);
      await expect(store.get(ref)).rejects.toThrow();
      await expect(store.delete(ref)).resolves.toBeUndefined();
    } finally {
      await dispose?.();
    }
  });

  it(`${name}: refuses refs outside the blob root`, async () => {
    const { store, dispose } = await factory();
    try {
      for (const ref of ['../escape', 'aa/../../escape', '/etc/passwd']) {
        await expect(store.get(ref)).rejects.toThrow();
        await expect(store.delete(ref)).rejects.toThrow();
      }
      await expect(store.get('aa/not-a-hash')).rejects.toThrow();
    } finally {
      await dispose?.();
    }
  });
}
