import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresDatabase } from '@triageai/kernel';

import { PgVectorStore } from '../src/services/capabilities.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const COLLECTION = `hybrid_test_${Date.now()}`;
const dims = 384;
const vector = (first: number, second: number): number[] => {
  const values = new Array<number>(dims).fill(0);
  values[0] = first;
  values[1] = second;
  return values;
};

let database: PostgresDatabase;
let store: PgVectorStore;

beforeAll(async () => {
  database = new PostgresDatabase(DATABASE_URL);
  store = new PgVectorStore(database);
  await store.upsert([
    {
      id: 'vector-match',
      collection: COLLECTION,
      documentId: 'doc-a',
      text: 'an unrelated sentence about tides',
      embedding: vector(1, 0),
      metadata: {
        approved: true,
        title: 'Tides',
        headingPath: 'Ocean',
        product: 'A',
        updatedAt: '2026-10-30T00:00:00.000Z',
      },
    },
    {
      id: 'keyword-match',
      collection: COLLECTION,
      documentId: 'doc-b',
      text: 'Refund policy: refunds take five business days.',
      embedding: vector(0, 1),
      metadata: {
        approved: true,
        title: 'Refunds',
        headingPath: 'Billing',
        product: 'B',
        updatedAt: '2026-10-30T00:00:00.000Z',
      },
    },
  ]);
});

afterAll(async () => {
  await database.query(`DELETE FROM vector_chunks WHERE collection = $1`, [COLLECTION]);
  await database.close();
});

describeIfDb('hybrid retrieval + HNSW (phase 13/18)', () => {
  it('fuses full-text and vector candidates', async () => {
    const candidates = await store.search(COLLECTION, vector(1, 0), {
      limit: 10,
      text: 'refund',
      filter: { approved: true },
    });
    expect(candidates.map((chunk) => chunk.id)).toContain('keyword-match');
    expect(candidates.map((chunk) => chunk.id)).toContain('vector-match');
  });

  it('applies metadata filters before retrieval', async () => {
    const rows = await store.search(COLLECTION, vector(1, 0), {
      limit: 10,
      text: 'refund',
      filter: { product: 'A' },
    });
    expect(rows.map((chunk) => chunk.id)).toEqual(['vector-match']);
  });

  it('has the HNSW index available for 384-dimensional vectors', async () => {
    const rows = await database.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'vector_chunks' AND indexname = 'vector_chunks_hnsw_384'`,
    );
    expect(rows[0]?.indexdef).toContain('hnsw');
    await database.query(`SET enable_seqscan = off`);
    const plan = await database.query<Record<string, unknown>>(
      `EXPLAIN SELECT id FROM vector_chunks
       WHERE collection = $1 AND dims = 384
       ORDER BY embedding::vector(384) <=> $2::vector(384) LIMIT 5`,
      [COLLECTION, `[${vector(1, 0).join(',')}]`],
    );
    const text = plan.map((row) => Object.values(row).join(' ')).join('\n');
    expect(text.toLowerCase()).toMatch(/hnsw|index scan/);
  });
});
