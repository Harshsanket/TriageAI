import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CORE_MIGRATIONS,
  MigrationRunner,
  MIGRATIONS_TABLE_SQL,
  PostgresDatabase,
} from '@triageai/kernel';

import { PgVectorStore } from '../src/services/capabilities.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const COLLECTION = `hybrid_test_${Date.now()}`;
const MODEL_A = 'test-embedder-a';
const MODEL_B = 'test-embedder-b';
const dims = 384;
const vector = (first: number, second: number): number[] => {
  const values = new Array<number>(dims).fill(0);
  values[0] = first;
  values[1] = second;
  return values;
};
const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let database: PostgresDatabase;
let store: PgVectorStore;

beforeAll(async () => {
  database = new PostgresDatabase(DATABASE_URL);
  store = new PgVectorStore(database);
  await database.query(MIGRATIONS_TABLE_SQL);
  await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
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
        embeddingModel: MODEL_A,
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
        embeddingModel: MODEL_A,
      },
    },
    {
      id: 'vector-noise',
      collection: COLLECTION,
      documentId: 'doc-c',
      text: 'another unrelated sentence',
      embedding: vector(1, 0),
      metadata: {
        approved: true,
        title: 'Noise',
        headingPath: 'Ocean',
        product: 'A',
        embeddingModel: MODEL_A,
      },
    },
    {
      id: 'other-model',
      collection: COLLECTION,
      documentId: 'doc-d',
      text: 'Refund policy from the other embedding model.',
      embeddingModel: MODEL_B,
      embedding: vector(1, 0),
      metadata: { approved: true, title: 'Other model' },
    },
  ]);
});

afterAll(async () => {
  await database.query(`DELETE FROM vector_chunks WHERE collection = $1`, [COLLECTION]);
  await database.close();
});

describeIfDb('hybrid retrieval + model scoping (phase 13/18)', () => {
  it('fuses full-text and vector candidates', async () => {
    const candidates = await store.search(COLLECTION, vector(1, 0), {
      limit: 2,
      text: 'refund',
      filter: { approved: true },
      model: MODEL_A,
    });
    expect(candidates.map((chunk) => chunk.id)).toContain('keyword-match');
  });

  it('switch off the keyword leg for the vector-only baseline', async () => {
    const candidates = await store.search(COLLECTION, vector(1, 0), {
      limit: 2,
      text: 'refund',
      model: MODEL_A,
      hybrid: false,
    });
    expect(candidates.map((chunk) => chunk.id)).not.toContain('keyword-match');
    expect(candidates).toHaveLength(2);
  });

  it('never mixes two same-dimension embedding models', async () => {
    const modelA = await store.search(COLLECTION, vector(1, 0), {
      limit: 10,
      text: 'refund',
      model: MODEL_A,
    });
    expect(modelA.map((chunk) => chunk.id)).not.toContain('other-model');
    expect(modelA.every((chunk) => chunk.metadata.embeddingModel !== MODEL_B)).toBe(true);

    // The exact-scan fallback (no keyword leg) applies the same model filter.
    const fallbackA = await store.search(COLLECTION, vector(1, 0), {
      limit: 10,
      model: MODEL_A,
      hybrid: false,
    });
    expect(fallbackA.map((chunk) => chunk.id)).not.toContain('other-model');

    const modelB = await store.search(COLLECTION, vector(1, 0), {
      limit: 10,
      text: 'refund',
      model: MODEL_B,
      hybrid: false,
    });
    expect(modelB.map((chunk) => chunk.id)).toEqual(['other-model']);

    // Rows written under a named model are not visible to the legacy default.
    const fallback = await store.search(COLLECTION, vector(1, 0), { limit: 10 });
    expect(fallback).toEqual([]);
  });

  it('applies metadata filters before retrieval', async () => {
    const rows = await store.search(COLLECTION, vector(1, 0), {
      limit: 10,
      text: 'refund',
      filter: { product: 'A' },
      model: MODEL_A,
    });
    expect(rows.map((chunk) => chunk.id).sort()).toEqual(['vector-match', 'vector-noise']);
  });
});
