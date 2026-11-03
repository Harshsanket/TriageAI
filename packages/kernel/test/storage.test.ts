import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { FilesystemBlobStore, MemoryCache } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('Cache contract (phase 18)', () => {
  it('stores, expires and reports hit rate', async () => {
    const cache = new MemoryCache(2);
    await cache.set('a', { x: 1 }, 50);
    expect(await cache.get<{ x: number }>('a')).toEqual({ x: 1 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await cache.get('a')).toBeUndefined();
    await cache.set('b', 1, 1000);
    await cache.set('c', 2, 1000);
    await cache.set('d', 3, 1000);
    expect(cache.stats().size).toBe(2);
    expect(cache.stats().hitRate).toBeGreaterThan(0);
  });

  it('clears every entry so disabled sources cannot be served from cache', async () => {
    const cache = new MemoryCache(10);
    await cache.set('retrieval:g0:kb_docs:1:abc', { chunks: ['disabled source text'] }, 60_000);
    await cache.set('generation:kb_docs:1:def', { text: 'cached answer' }, 60_000);
    expect(cache.stats().size).toBe(2);
    await cache.clear();
    expect(cache.stats().size).toBe(0);
    expect(await cache.get('retrieval:g0:kb_docs:1:abc')).toBeUndefined();
    expect(await cache.get('generation:kb_docs:1:def')).toBeUndefined();
  });
});

describe('BlobStore contract (phase 18)', () => {
  it('is content-addressed, idempotent and delete-safe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triageai-blobs-'));
    roots.push(root);
    const store = new FilesystemBlobStore(root);
    const first = await store.put(Buffer.from('hello'), { contentType: 'text/plain' });
    const second = await store.put(Buffer.from('hello'), { contentType: 'text/plain' });
    expect(first.ref).toBe(second.ref);
    expect(Buffer.from(await store.get(first.ref)).toString()).toBe('hello');
    await store.delete(first.ref);
    await expect(store.get(first.ref)).rejects.toThrow();
  });
});
