import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CORE_MIGRATIONS,
  HNSW_MAX_DIMS,
  MigrationRunner,
  MIGRATIONS_TABLE_SQL,
  PostgresDatabase,
  ensureVectorIndexes,
  vectorIndexName,
  type VectorIndexReport,
} from '@triageai/kernel';

import { PgVectorStore } from '../src/services/capabilities.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const INDEXED_COLLECTION = `vec_index_test_${Date.now()}`;
const QUOTED_COLLECTION = `vec_index_'quoted_${Date.now()}`;
const UNSUPPORTED_COLLECTION = `vec_index_oversize_${Date.now()}`;
const MODEL_A = 'test-embedder-a';
const MODEL_B = "test-embedder-'b";
const DIMS = 384;
const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const vector = (dims: number, first: number): number[] => {
  const values = new Array<number>(dims).fill(0);
  values[0] = first;
  return values;
};

let database: PostgresDatabase;
let store: PgVectorStore;
let firstReport: VectorIndexReport;

const names = (): string[] => [
  vectorIndexName(INDEXED_COLLECTION, MODEL_A, DIMS),
  vectorIndexName(INDEXED_COLLECTION, MODEL_B, DIMS),
  vectorIndexName(QUOTED_COLLECTION, MODEL_A, DIMS),
];

beforeAll(async () => {
  database = new PostgresDatabase(DATABASE_URL);
  store = new PgVectorStore(database);
  await database.query(MIGRATIONS_TABLE_SQL);
  await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
  await store.upsert([
    {
      id: 'a',
      collection: INDEXED_COLLECTION,
      documentId: 'doc-a',
      text: 'alpha',
      embedding: vector(DIMS, 1),
      metadata: { embeddingModel: MODEL_A },
    },
    {
      id: 'b',
      collection: INDEXED_COLLECTION,
      documentId: 'doc-b',
      text: 'beta',
      embedding: vector(DIMS, 0.5),
      metadata: { embeddingModel: MODEL_B },
    },
    {
      id: 'q',
      collection: QUOTED_COLLECTION,
      documentId: 'doc-q',
      text: 'quoted',
      embedding: vector(DIMS, 1),
      metadata: { embeddingModel: MODEL_A },
    },
    {
      id: 'oversize',
      collection: UNSUPPORTED_COLLECTION,
      documentId: 'doc-o',
      text: 'oversize',
      embedding: vector(HNSW_MAX_DIMS + 1, 1),
      metadata: { embeddingModel: MODEL_A },
    },
  ]);
  firstReport = await ensureVectorIndexes(database);
});

afterAll(async () => {
  await database.query(`DELETE FROM vector_chunks WHERE collection = ANY($1::text[])`, [
    [INDEXED_COLLECTION, QUOTED_COLLECTION, UNSUPPORTED_COLLECTION],
  ]);
  for (const name of names()) {
    await database.query(`DROP INDEX IF EXISTS "${name}"`);
  }
  await database.close();
});

describeIfDb('per-(collection, model, dims) HNSW provisioning (18.T9)', () => {
  it('creates one partial HNSW index per active pair', async () => {
    for (const name of names()) expect(firstReport.created).toContain(name);
    const [definition] = await database.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'vector_chunks' AND indexname = $1`,
      [vectorIndexName(INDEXED_COLLECTION, MODEL_A, DIMS)],
    );
    expect(definition?.indexdef).toContain('hnsw');
    expect(definition?.indexdef).toContain(`collection = '${INDEXED_COLLECTION}'`);
    expect(definition?.indexdef).toContain(`embedding_model = '${MODEL_A}'`);
    expect(definition?.indexdef).toContain('WHERE');
  });

  it('escapes collection/model literals in the predicate', async () => {
    const [definition] = await database.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'vector_chunks' AND indexname = $1`,
      [vectorIndexName(QUOTED_COLLECTION, MODEL_A, DIMS)],
    );
    // The quote in the collection name survives as an escaped SQL literal.
    expect(definition?.indexdef).toContain("'quoted");
    expect(definition?.indexdef).toContain("''");
  });

  it('skips dimensions pgvector cannot index', async () => {
    expect(firstReport.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: UNSUPPORTED_COLLECTION,
          dims: HNSW_MAX_DIMS + 1,
          reason: 'unsupported_dims',
        }),
      ]),
    );
    const [row] = await database.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [vectorIndexName(UNSUPPORTED_COLLECTION, MODEL_A, HNSW_MAX_DIMS + 1)],
    );
    expect(row?.present).toBe(false);
  });

  it('is idempotent on a second run', async () => {
    const second = await ensureVectorIndexes(database);
    for (const name of names()) {
      expect(second.created).not.toContain(name);
      expect(second.existing).toContain(name);
    }
  });

  it('uses the per-pair index when sequential scans are disabled', async () => {
    const ownIndex = vectorIndexName(INDEXED_COLLECTION, MODEL_A, DIMS);
    const otherIndex = vectorIndexName(INDEXED_COLLECTION, MODEL_B, DIMS);
    // SET LOCAL only applies to this transaction/connection; the pool would
    // spread statements across sessions.
    await database.transaction(async (tx) => {
      await tx.query(`SET LOCAL enable_seqscan = off`);
      const plan = await tx.query<Record<string, unknown>>(
        `EXPLAIN SELECT id FROM vector_chunks
          WHERE collection = '${INDEXED_COLLECTION}' AND embedding_model = '${MODEL_A}' AND dims = 384
          ORDER BY embedding::vector(384) <=> $1::vector(384)
          LIMIT 5`,
        [`[${vector(DIMS, 1).join(',')}]`],
      );
      const text = plan.map((row) => Object.values(row).join(' ')).join('\n');
      expect(text).toContain(ownIndex);
      expect(text).not.toContain(otherIndex);
    });
  });
});
