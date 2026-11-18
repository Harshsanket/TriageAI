import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  FilesystemBlobStore,
  MemoryCache,
  PostgresDatabase,
  RedisCache,
  S3BlobStore,
} from '@triageai/kernel';
import type { Capabilities, Kernel, KernelConfig, VectorStore } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import {
  PgRetriever,
  PgVectorStore,
  createBlobStoreAdapter,
  createCacheAdapter,
  type HttpEmbedder,
} from '../src/services/capabilities.js';

function config(overrides: Record<string, unknown> = {}): KernelConfig {
  return {
    profile: 'core',
    queue: { adapter: 'pg-queue' },
    modules: {},
    capabilities: {},
    ...overrides,
  } as KernelConfig;
}

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('storage adapter selection (18.T11/T12)', () => {
  it('uses memory + filesystem when the config is silent', async () => {
    const root = await tempDir('triageai-selected-blobs-');
    const cache = createCacheAdapter(config(), {});
    const blob = createBlobStoreAdapter(config(), { TRIAGEAI_BLOB_ROOT: root });
    expect(cache).toBeInstanceOf(MemoryCache);
    expect(blob).toBeInstanceOf(FilesystemBlobStore);
    const stored = await (blob as FilesystemBlobStore).put(Buffer.from('selected'), {
      contentType: 'text/plain',
    });
    expect(Buffer.from(await (blob as FilesystemBlobStore).get(stored.ref)).toString()).toBe(
      'selected',
    );
  });

  it('honours the memory LRU bound from capabilities.cache', async () => {
    const cache = createCacheAdapter(
      config({ capabilities: { cache: { adapter: 'memory', maxEntries: 2 } } }),
      {},
    );
    await cache.set('a', 1, 60_000);
    await cache.set('b', 2, 60_000);
    await cache.set('c', 3, 60_000);
    expect(cache).toBeInstanceOf(MemoryCache);
    expect((cache as MemoryCache).stats().size).toBe(2);
  });

  it('resolves the filesystem root under TRIAGEAI_DATA_DIR', async () => {
    const dataDir = await tempDir('triageai-storage-data-');
    const blob = createBlobStoreAdapter(
      config({ capabilities: { blobStore: { adapter: 'filesystem' } } }),
      { TRIAGEAI_DATA_DIR: dataDir },
    );
    const stored = await (blob as FilesystemBlobStore).put(Buffer.from('data-dir'), {
      contentType: 'text/plain',
    });
    expect(await readFile(path.join(dataDir, 'data/blobs', stored.ref), 'utf8')).toBe('data-dir');
  });

  it('refuses a redis selection without its named env', () => {
    expect(() =>
      createCacheAdapter(config({ capabilities: { cache: { adapter: 'redis' } } }), {}),
    ).toThrow(/REDIS_URL/);
    expect(() =>
      createCacheAdapter(
        config({
          capabilities: { cache: { adapter: 'redis', urlEnv: 'TENANT_REDIS_URL' } },
        }),
        { REDIS_URL: 'redis://localhost:6379' },
      ),
    ).toThrow(/TENANT_REDIS_URL/);
  });

  it('refuses an s3 selection until all three env values are present', () => {
    expect(() =>
      createBlobStoreAdapter(config({ capabilities: { blobStore: { adapter: 's3' } } }), {
        TRIAGEAI_S3_ENDPOINT: 'http://localhost:9000',
      }),
    ).toThrow(/TRIAGEAI_S3_ACCESS_KEY, TRIAGEAI_S3_SECRET_KEY/);
    const blob = createBlobStoreAdapter(
      config({ capabilities: { blobStore: { adapter: 's3' } } }),
      {
        TRIAGEAI_S3_ENDPOINT: 'http://localhost:9000',
        TRIAGEAI_S3_ACCESS_KEY: 'key',
        TRIAGEAI_S3_SECRET_KEY: 'secret',
      },
    );
    expect(blob).toBeInstanceOf(S3BlobStore);
  });

  it('rejects unknown adapters at the selection boundary', () => {
    expect(() =>
      createCacheAdapter(config({ capabilities: { cache: { adapter: 'nope' } } }), {}),
    ).toThrow(/capabilities\.cache\.adapter/);
    expect(() =>
      createBlobStoreAdapter(config({ capabilities: { blobStore: { adapter: 'gcs' } } }), {}),
    ).toThrow(/capabilities\.blobStore\.adapter/);
  });

  const describeIfRedis = process.env.REDIS_URL ? describe : describe.skip;
  describeIfRedis('redis selection (18.T11)', () => {
    it('closes a never-connected client without opening a socket', async () => {
      const cache = createCacheAdapter(
        config({
          capabilities: { cache: { adapter: 'redis', namespace: 'triageai:test:unused' } },
        }),
        process.env,
      );
      expect(cache).toBeInstanceOf(RedisCache);
      await expect(cache.close?.()).resolves.toBeUndefined();
    });

    it('builds a namespace-scoped RedisCache against the named env', async () => {
      const cache = createCacheAdapter(
        config({
          capabilities: {
            cache: { adapter: 'redis', namespace: `triageai:test:select:${Date.now()}` },
          },
        }),
        process.env,
      );
      try {
        expect(cache).toBeInstanceOf(RedisCache);
        await cache.set('k', { ok: true }, 60_000);
        expect(await cache.get('k')).toEqual({ ok: true });
        await cache.clear?.();
        expect(await cache.get('k')).toBeUndefined();
      } finally {
        await cache.close?.();
      }
    });
  });
});

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const DIMENSIONS = 384;
const COLLECTION = `kb_blob_${Date.now()}`;

function vectorFor(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) % DIMENSIONS;
    vector[hash] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

const fakeEmbedder = {
  embed: async (texts: string[]) => ({
    vectors: texts.map(vectorFor),
    modelVersion: 'fake-embed-384',
  }),
};

describeIfDb('KB upload uses the selected BlobStore (18.T12)', () => {
  let app: FastifyInstance & { kernel?: Kernel };
  let database: PostgresDatabase;
  let blobRoot = '';
  let workDir = '';
  let sourceId = '';

  afterAll(async () => {
    await app?.close();
    if (database) {
      if (sourceId) {
        await database.query(
          `DELETE FROM vector_chunks WHERE document_id IN
             (SELECT id FROM mod_kb.kb_documents WHERE source_id = $1)`,
          [sourceId],
        );
        await database.query(`DELETE FROM mod_kb.kb_ingest_items WHERE source_id = $1`, [sourceId]);
        await database.query(
          `DELETE FROM mod_kb.kb_ingest_runs WHERE document_id IN
             (SELECT id FROM mod_kb.kb_documents WHERE source_id = $1)`,
          [sourceId],
        );
        await database.query(`DELETE FROM mod_kb.kb_documents WHERE source_id = $1`, [sourceId]);
        await database.query(`DELETE FROM mod_kb.kb_sources WHERE id = $1`, [sourceId]);
      }
      await database.close();
    }
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 60_000);

  it('stores file bytes through the capability and reads them back for ingest', async () => {
    workDir = await tempDir('triageai-kb-blob-');
    blobRoot = path.join(workDir, 'blobs');
    const configPath = path.join(workDir, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'pg-queue', pollIntervalMs: 50 },
        modules: { kb: { enabled: true, options: { collection: COLLECTION } } },
        // No TRIAGEAI_BLOB_ROOT override: selection must use this root.
        capabilities: { blobStore: { adapter: 'filesystem', root: blobRoot } },
      }),
    );
    database = new PostgresDatabase(DATABASE_URL);
    const vectorStore: VectorStore = new PgVectorStore(database);
    // Inject only the AI seams; blobStore is filled by createBlobStoreAdapter
    // from the file config, which is what this smoke test exercises.
    const capabilities: Capabilities = {
      embedder: fakeEmbedder as unknown as HttpEmbedder,
      vectorStore,
      retriever: new PgRetriever(fakeEmbedder, vectorStore, 0.1, 0.001),
    };
    app = (await buildApp({
      quiet: true,
      configPath,
      setup: false,
      authMode: 'disabled',
      capabilities,
    })) as FastifyInstance & { kernel?: Kernel };

    const body = Buffer.from('# Blob smoke\n\nKeep this file in the blob store.');
    const title = `Blob smoke ${Date.now()}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/sources',
      payload: {
        kind: 'file',
        title,
        mediaType: 'text/markdown',
        contentBase64: body.toString('base64'),
      },
    });
    expect(created.statusCode).toBe(200);

    const rows = await database.query<{ id: string; blob_ref: string; size_bytes: string }>(
      `SELECT id, blob_ref, size_bytes FROM mod_kb.kb_sources WHERE title = $1`,
      [title],
    );
    const source = rows[0];
    expect(source?.blob_ref).toBeTruthy();
    sourceId = source?.id ?? '';
    const expectedHash = createHash('sha256').update(body).digest('hex');
    expect(source?.blob_ref).toBe(`${expectedHash.slice(0, 2)}/${expectedHash}`);
    expect(Number(source?.size_bytes)).toBe(body.length);
    expect(await readFile(path.join(blobRoot, source?.blob_ref as string))).toEqual(body);

    const documents = await database.query<{ id: string; body: string }>(
      `SELECT id, body FROM mod_kb.kb_documents WHERE source_id = $1`,
      [sourceId],
    );
    expect(documents[0]?.id).toBeTruthy();
    // The ingest stage read the bytes back through BlobStore.get() and stored
    // the extracted text on the document.
    expect(documents[0]?.body).toContain('Keep this file in the blob store');

    const sources = await app.inject({
      method: 'GET',
      url: `/api/v1/kb/sources?q=${encodeURIComponent(title)}`,
    });
    expect(sources.statusCode).toBe(200);
    const listed = (
      sources.json() as { sources: Array<{ id: string; storage?: string[] }> }
    ).sources.find((entry) => entry.id === sourceId);
    expect(listed?.storage).toContain('Blob store');
  }, 60_000);
});
