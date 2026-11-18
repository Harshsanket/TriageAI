/**
 * Per-(collection, embedding model, dims) HNSW provisioning (18.T9/18.7).
 *
 * Static migrations cannot parameterise row values, so the partial index set is
 * derived from the pairs actually present in `vector_chunks`. An index predicate
 * includes the collection, model and dims, so a query that filters on all three
 * never sees another model's graph (mixing two same-dimension models would
 * otherwise return each other's neighbours).
 *
 * Idempotent and safe on races: creation uses `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS`, existing/invalid indexes are detected first, and duplicate-relation
 * errors from a concurrent boot are treated as "already there".
 */
import { createHash } from 'node:crypto';

import type { Database } from '../types.js';

/**
 * pgvector's HNSW limit for the `vector` type (dimensions above this cannot be
 * indexed; those pairs keep the exact scan). `halfvec` would raise the limit but
 * changes the column type, which is out of scope here.
 */
export const HNSW_MAX_DIMS = 2_000;

const INDEX_PREFIX = 'vector_chunks_hnsw';

/** One HNSW index target: rows sharing these three values form a graph. */
export interface VectorIndexPair {
  collection: string;
  embeddingModel: string;
  dims: number;
}

export type VectorIndexSkipReason = 'unsupported_dims' | 'create_failed';

export interface VectorIndexSkip extends VectorIndexPair {
  reason: VectorIndexSkipReason;
  detail?: string;
}

export interface VectorIndexReport {
  /** Indexes built by this call. */
  created: string[];
  /** Indexes that already existed (including a concurrent creator's). */
  existing: string[];
  skipped: VectorIndexSkip[];
}

/** Deterministic, length-safe index name (Postgres identifiers cap at 63 bytes). */
export function vectorIndexName(collection: string, embeddingModel: string, dims: number): string {
  const digest = createHash('sha256')
    .update(`${collection}\u0000${embeddingModel}`)
    .digest('hex')
    .slice(0, 16);
  return `${INDEX_PREFIX}_${dims}_${digest}`;
}

/** Identifiers are generated above; quote defensively anyway. */
function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Values come from the table; quote literals instead of interpolating raw text. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The DDL for one pair; exported for tests/tooling that need the exact SQL. */
export function vectorIndexDdl(pair: VectorIndexPair): string {
  if (!Number.isInteger(pair.dims) || pair.dims <= 0) {
    throw new Error(`invalid vector index dimensions: ${String(pair.dims)}`);
  }
  const name = vectorIndexName(pair.collection, pair.embeddingModel, pair.dims);
  return (
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(name)} ` +
    `ON vector_chunks USING hnsw ((embedding::vector(${pair.dims})) vector_cosine_ops) ` +
    `WHERE collection = ${quoteLiteral(pair.collection)} ` +
    `AND embedding_model = ${quoteLiteral(pair.embeddingModel)} ` +
    `AND dims = ${pair.dims}`
  );
}

interface PairRow {
  [key: string]: unknown;
  collection: string;
  embedding_model: string;
  dims: number;
}

interface IndexRow {
  [key: string]: unknown;
  present: boolean;
  valid: boolean | null;
}

const DUPLICATE_RELATION = new Set(['42P07', '23505', '42710']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function indexState(database: Database, name: string): Promise<IndexRow> {
  const rows = await database.query<IndexRow>(
    `SELECT true AS present, i.indisvalid AS valid
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1`,
    [name],
  );
  return rows[0] ?? { present: false, valid: null };
}

/**
 * Create the partial HNSW index for every active `(collection, model, dims)`
 * pair. Never throws for one bad pair: unsupported dimensions and failed builds
 * are reported so the caller can log them; boot must keep working.
 */
export async function ensureVectorIndexes(
  database: Database,
  options: { maxDims?: number } = {},
): Promise<VectorIndexReport> {
  const maxDims = options.maxDims ?? HNSW_MAX_DIMS;
  const report: VectorIndexReport = { created: [], existing: [], skipped: [] };
  const pairs = await database.query<PairRow>(
    `SELECT collection, embedding_model, dims
       FROM vector_chunks
      WHERE dims IS NOT NULL
      GROUP BY collection, embedding_model, dims
      ORDER BY collection, embedding_model, dims`,
  );

  for (const row of pairs) {
    const pair: VectorIndexPair = {
      collection: row.collection,
      embeddingModel: row.embedding_model,
      dims: Number(row.dims),
    };
    const name = vectorIndexName(pair.collection, pair.embeddingModel, pair.dims);
    if (!Number.isInteger(pair.dims) || pair.dims <= 0 || pair.dims > maxDims) {
      report.skipped.push({ ...pair, reason: 'unsupported_dims' });
      continue;
    }
    try {
      const state = await indexState(database, name);
      if (state.present && state.valid === true) {
        report.existing.push(name);
        continue;
      }
      if (state.present) {
        // A failed concurrent build leaves an invalid index; replace it.
        await database.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(name)}`);
      }
      await database.query(vectorIndexDdl(pair));
      report.created.push(name);
    } catch (error) {
      const code = errorCode(error);
      if (code && DUPLICATE_RELATION.has(code)) {
        // Another process won the race; the index exists either way.
        report.existing.push(name);
        continue;
      }
      report.skipped.push({
        ...pair,
        reason: 'create_failed',
        detail: (error as Error).message,
      });
    }
  }
  return report;
}
