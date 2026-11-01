import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { KbStorageStatsSchema } from '@triageai/contracts';
import type { Capabilities, Kernel, VectorStore } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { PgRetriever, PgVectorStore, type HttpEmbedder } from '../src/services/capabilities.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const DIMENSIONS = 384;
const COLLECTION = `kb_phase20_${Date.now()}`;
const TITLE = `Phase 20 dedupe ${Date.now()}`;
const BODY =
  '# Refunds\n\nRefunds are processed within five business days. Contact billing for refund questions.';

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

describeIfDb('knowledge sources (phase 20)', () => {
  let app: FastifyInstance & { kernel?: Kernel };
  let database: PostgresDatabase;
  let dir: string;
  let documentId = '';
  let sourceId = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'triageai-kb20-'));
    const configPath = path.join(dir, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'pg-queue', pollIntervalMs: 50 },
        modules: { kb: { enabled: true, options: { collection: COLLECTION } } },
        capabilities: {
          embedder: { adapter: 'test' },
          vectorStore: { adapter: 'test' },
          retriever: { adapter: 'test' },
        },
      }),
    );
    database = new PostgresDatabase(DATABASE_URL);
    const vectorStore: VectorStore = new PgVectorStore(database);
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
  }, 60_000);

  afterAll(async () => {
    await database.query(`DELETE FROM vector_chunks WHERE collection = $1`, [COLLECTION]);
    await database.query(`DELETE FROM mod_kb.kb_ingest_items WHERE source_id = $1`, [sourceId]);
    await database.query(`DELETE FROM mod_kb.kb_ingest_runs WHERE document_id = $1`, [documentId]);
    await database.query(`DELETE FROM mod_kb.kb_documents WHERE source_id = $1`, [sourceId]);
    await database.query(`DELETE FROM mod_kb.kb_sources WHERE id = $1`, [sourceId]);
    await app.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('dedupes the same content and toggles retrieval per source', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/documents',
      payload: { title: TITLE, body: BODY },
    });
    expect(created.statusCode).toBe(200);
    const first = created.json() as {
      document: { id: string; approved: boolean };
      ingest: { chunks: number; deduped: boolean };
    };
    documentId = first.document.id;
    expect(first.ingest.chunks).toBeGreaterThan(0);
    expect(first.ingest.deduped).toBe(false);

    const sources = await app.inject({
      method: 'GET',
      url: `/api/v1/kb/sources?q=${encodeURIComponent(TITLE)}`,
    });
    expect(sources.statusCode).toBe(200);
    const source = (sources.json() as { sources: Array<{ id: string; status: string }> })
      .sources[0];
    expect(source?.status).toBe('ready');
    sourceId = source?.id ?? '';

    const storage = await app.inject({ method: 'GET', url: '/api/v1/kb/storage' });
    expect(storage.statusCode).toBe(200);
    const stats = KbStorageStatsSchema.parse(storage.json());
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.sources.some((entry) => entry.id === sourceId)).toBe(true);
    expect(stats.documents).toBeGreaterThan(0);

    const chunksAfterFirst = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM vector_chunks WHERE collection = $1 AND document_id = $2`,
      [COLLECTION, documentId],
    );

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/documents',
      payload: { title: `${TITLE} again`, body: BODY },
    });
    const second = duplicate.json() as {
      document: { id: string };
      ingest: { chunks: number; deduped: boolean };
    };
    expect(second.document.id).toBe(documentId);
    expect(second.ingest.deduped).toBe(true);
    expect(second.ingest.chunks).toBe(0);
    const chunksAfterSecond = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM vector_chunks WHERE collection = $1 AND document_id = $2`,
      [COLLECTION, documentId],
    );
    expect(chunksAfterSecond[0]?.count).toBe(chunksAfterFirst[0]?.count);

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/search',
      payload: { query: 'how long do refunds take' },
    });
    expect((after.json() as { chunks: unknown[] }).chunks.length).toBeGreaterThan(0);

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/kb/sources/${sourceId}`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    const hidden = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/search',
      payload: { query: 'how long do refunds take' },
    });
    expect((hidden.json() as { chunks: unknown[] }).chunks).toHaveLength(0);

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/v1/kb/sources/${sourceId}`,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    const restored = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/search',
      payload: { query: 'how long do refunds take' },
    });
    expect((restored.json() as { chunks: unknown[] }).chunks.length).toBeGreaterThan(0);

    const jobs = await app.inject({ method: 'GET', url: '/api/v1/system/jobs' });
    const jobsBody = jobs.json() as {
      active: Array<{ title: string }>;
      recent: Array<{ title: string }>;
    };
    expect([...jobsBody.active, ...jobsBody.recent].map((job) => job.title)).toContain(TITLE);
  }, 60_000);
});
