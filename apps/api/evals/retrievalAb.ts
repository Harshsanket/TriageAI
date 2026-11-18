/**
 * Retrieval A/B scoring (18.T9): the same labelled queries run through hybrid
 * (vector + full-text RRF) and vector-only retrieval, so the report can gate
 * "hybrid must not lose recall against the baseline". Pure functions: the eval
 * script supplies a live DB-backed search, tests supply a deterministic fake.
 */

export interface RetrievalQueryCase {
  query: string;
  expectedDocument: string;
}

export interface RetrievalRow {
  query: string;
  expected: string;
  retrieved: string[];
  rank: number | null;
}

export interface RetrievalMetrics {
  recallAt3: number;
  mrr: number;
  results: RetrievalRow[];
}

export type RetrievalMode = 'hybrid' | 'vectorOnly';

export interface RetrievalHit {
  documentId: string;
}

export type RetrievalSearch = (
  collection: string,
  query: string,
  opts: { limit: number; hybrid: boolean },
) => Promise<RetrievalHit[]>;

export interface RetrievalAbReport {
  generatedAt?: string;
  collection: string;
  queries: number;
  topK: number;
  /** Hybrid metrics (the production mode); kept for older report readers. */
  recallAt3: number;
  mrr: number;
  gates: { recallAt3: number };
  hybrid: RetrievalMetrics;
  vectorOnly: RetrievalMetrics;
  /** hybrid − vectorOnly, rounded like the metrics. */
  delta: { recallAt3: number; mrr: number };
  /** Hybrid row detail; kept for older report readers. */
  results: RetrievalRow[];
}

export interface RetrievalAbInput {
  collection: string;
  queries: RetrievalQueryCase[];
  topK: number;
  gates: { recallAt3: number };
  search: RetrievalSearch;
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

async function measure(mode: RetrievalMode, input: RetrievalAbInput): Promise<RetrievalMetrics> {
  const rows: RetrievalRow[] = [];
  let hits = 0;
  let reciprocalRankSum = 0;
  for (const item of input.queries) {
    const retrieved = (
      await input.search(input.collection, item.query, {
        limit: input.topK,
        hybrid: mode === 'hybrid',
      })
    ).map((hit) => hit.documentId);
    const rank = retrieved.indexOf(item.expectedDocument);
    const rankOneBased = rank >= 0 ? rank + 1 : null;
    if (rankOneBased !== null) {
      hits += 1;
      reciprocalRankSum += 1 / rankOneBased;
    }
    rows.push({
      query: item.query,
      expected: item.expectedDocument,
      retrieved,
      rank: rankOneBased,
    });
  }
  const total = input.queries.length;
  return {
    recallAt3: total === 0 ? 0 : round(hits / total),
    mrr: total === 0 ? 0 : round(reciprocalRankSum / total),
    results: rows,
  };
}

/** Run both retrieval modes on the same fixtures and compute the delta. */
export async function evaluateRetrievalAb(input: RetrievalAbInput): Promise<RetrievalAbReport> {
  const hybrid = await measure('hybrid', input);
  const vectorOnly = await measure('vectorOnly', input);
  return {
    collection: input.collection,
    queries: input.queries.length,
    topK: input.topK,
    recallAt3: hybrid.recallAt3,
    mrr: hybrid.mrr,
    gates: input.gates,
    hybrid,
    vectorOnly,
    delta: {
      recallAt3: round(hybrid.recallAt3 - vectorOnly.recallAt3),
      mrr: round(hybrid.mrr - vectorOnly.mrr),
    },
    results: hybrid.results,
  };
}

/**
 * Gate: hybrid recall must not regress against the vector-only baseline, and
 * must still meet the absolute floor. Returns the failure text or null.
 */
export function retrievalAbFailure(
  report: Pick<RetrievalAbReport, 'hybrid' | 'vectorOnly' | 'gates' | 'topK'>,
): string | null {
  if (report.hybrid.recallAt3 < report.vectorOnly.recallAt3) {
    return (
      `GATE FAILURE: hybrid recall@${report.topK} ${report.hybrid.recallAt3} ` +
      `< vector-only ${report.vectorOnly.recallAt3}`
    );
  }
  if (report.hybrid.recallAt3 < report.gates.recallAt3) {
    return (
      `GATE FAILURE: recall@${report.topK} ${report.hybrid.recallAt3} ` +
      `< ${report.gates.recallAt3}`
    );
  }
  return null;
}
