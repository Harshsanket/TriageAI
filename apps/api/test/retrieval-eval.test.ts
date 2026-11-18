import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateRetrievalAb,
  retrievalAbFailure,
  type RetrievalQueryCase,
  type RetrievalSearch,
} from '../evals/retrievalAb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function fixtures(): Promise<RetrievalQueryCase[]> {
  const parsed = JSON.parse(
    await readFile(path.join(HERE, '../evals/fixtures/kb.json'), 'utf8'),
  ) as { queries: RetrievalQueryCase[] };
  return parsed.queries;
}

describe('retrieval A/B report (18.T9)', () => {
  it('runs both modes on the same fixtures and reports the delta', async () => {
    const queries = await fixtures();
    const expected = new Map(queries.map((item) => [item.query, item.expectedDocument]));
    const modes: boolean[] = [];
    // Deterministic stand-in for the live embedder/DB: hybrid finds the labelled
    // document for every query, the vector-only baseline misses half of them.
    const search: RetrievalSearch = async (_collection, query, opts) => {
      modes.push(opts.hybrid);
      const document = expected.get(query) ?? 'missing';
      const noise = [
        { documentId: 'noise-1' },
        { documentId: 'noise-2' },
        { documentId: 'noise-3' },
      ];
      if (opts.hybrid || queries.findIndex((item) => item.query === query) % 2 === 0) {
        return [{ documentId: document }, ...noise].slice(0, opts.limit);
      }
      return noise.slice(0, opts.limit);
    };

    const report = await evaluateRetrievalAb({
      collection: 'eval_kb_docs',
      queries,
      topK: 3,
      gates: { recallAt3: 0.8 },
      search,
    });

    expect(report.queries).toBe(queries.length);
    expect(report.topK).toBe(3);
    expect(report.hybrid.recallAt3).toBe(1);
    expect(report.vectorOnly.recallAt3).toBe(0.5);
    expect(report.delta.recallAt3).toBe(0.5);
    expect(report.recallAt3).toBe(report.hybrid.recallAt3);
    expect(report.results).toEqual(report.hybrid.results);
    expect(report.hybrid.results).toHaveLength(queries.length);
    expect(report.hybrid.results.every((row) => row.rank === 1)).toBe(true);
    expect(modes.filter(Boolean)).toHaveLength(queries.length);
    expect(modes.filter((hybrid) => !hybrid)).toHaveLength(queries.length);
    expect(retrievalAbFailure(report)).toBeNull();

    // JSON shape consumed by merge.eval.ts / the model registry.
    const json = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    expect(json).toMatchObject({
      collection: 'eval_kb_docs',
      queries: queries.length,
      gates: { recallAt3: 0.8 },
      delta: { recallAt3: 0.5 },
      hybrid: { recallAt3: 1 },
      vectorOnly: { recallAt3: 0.5 },
    });
  });

  it('fails the gate when hybrid regresses against vector-only', async () => {
    const queries = await fixtures();
    const search: RetrievalSearch = async (_collection, _query, opts) =>
      opts.hybrid ? [{ documentId: 'noise' }] : [{ documentId: 'expected' }];
    const report = await evaluateRetrievalAb({
      collection: 'eval_kb_docs',
      queries: queries.slice(0, 2),
      topK: 3,
      gates: { recallAt3: 0 },
      search,
    });
    expect(report.hybrid.recallAt3).toBe(0);
    expect(report.vectorOnly.recallAt3).toBe(0); // fixtures label specific docs
    const failing = {
      ...report,
      vectorOnly: { ...report.vectorOnly, recallAt3: 1 },
      delta: { recallAt3: -1, mrr: 0 },
    };
    expect(retrievalAbFailure(failing)).toContain('vector-only');
  });

  it('keeps the absolute recall floor', async () => {
    const queries = await fixtures();
    const search: RetrievalSearch = async (_collection, _query, opts) =>
      opts.hybrid ? [{ documentId: 'hit' }] : [{ documentId: 'hit' }];
    const report = await evaluateRetrievalAb({
      collection: 'eval_kb_docs',
      queries,
      topK: 3,
      gates: { recallAt3: 0.8 },
      search,
    });
    expect(report.hybrid.recallAt3).toBe(0);
    expect(retrievalAbFailure(report)).toContain('GATE FAILURE: recall@3');
  });
});
