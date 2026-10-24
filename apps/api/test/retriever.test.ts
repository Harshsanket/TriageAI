import { describe, expect, it } from 'vitest';

import type { VectorMatch, VectorStore } from '@triageai/kernel';

import { PgRetriever } from '../src/platform/capabilities.js';

const embedder = {
  embed: async (texts: string[]) => ({
    vectors: texts.map(() => [1, 0]),
    modelVersion: 'fake',
  }),
};

function storeWith(scores: number[]): VectorStore {
  return {
    upsert: async () => undefined,
    deleteByDocument: async () => undefined,
    search: async () =>
      scores.map((score, index) => ({
        id: `chunk-${index}`,
        documentId: `doc-${index}`,
        text: `chunk ${index}`,
        score,
        metadata: {},
      })) as VectorMatch[],
  } as VectorStore;
}

describe('retriever per-collection gates', () => {
  it('applies a collection-specific margin without changing the default', async () => {
    const retriever = new PgRetriever(embedder, storeWith([0.477, 0.453]), 0.35, 0.05, {
      project_docs: { margin: 0.01 },
    });

    const docs = await retriever.search('project_docs', 'why postgres?');
    expect(docs.gate).toMatchObject({ sufficient: true, marginThreshold: 0.01, topScore: 0.477 });

    const kb = await retriever.search('kb_docs', 'why postgres?');
    expect(kb.gate).toMatchObject({ sufficient: false, marginThreshold: 0.05 });
  });

  it('falls back to the default threshold for unknown collections', async () => {
    const retriever = new PgRetriever(embedder, storeWith([0.3, 0.1]), 0.35, 0.05);
    const result = await retriever.search('other', 'q');
    expect(result.gate).toMatchObject({
      sufficient: false,
      threshold: 0.35,
      marginThreshold: 0.05,
    });
  });
});
