/**
 * Retrieval eval (Phase 4, CI gate): seeds fixture documents through the real
 * embedder + pgvector store, then measures recall@3 and MRR on labeled queries
 * in both modes — hybrid (production) and vector-only (baseline, 18.T9). The
 * gate requires hybrid recall not to regress against the baseline and to stay
 * above the absolute floor.
 *
 *   AI_SERVICE_URL=http://localhost:8000 DATABASE_URL=... \
 *   pnpm --filter @triageai/api exec tsx evals/retrieval.eval.ts
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORE_MIGRATIONS,
  MIGRATIONS_TABLE_SQL,
  MigrationRunner,
  PostgresDatabase,
} from '@triageai/kernel';
import { chunkText } from '@triageai/rag';

import { HttpEmbedder, PgRetriever, PgVectorStore } from '../src/services/capabilities.js';
import { evaluateRetrievalAb, retrievalAbFailure } from './retrievalAb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECTION = 'eval_kb_docs';
const TOP_K = 3;
const GATES = { recallAt3: 0.8 };

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function main(): Promise<number> {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
  const aiBase = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';
  const fixtures = JSON.parse(await readFile(path.join(HERE, 'fixtures/kb.json'), 'utf8')) as {
    documents: Array<{ id: string; title: string; body: string }>;
    queries: Array<{ query: string; expectedDocument: string }>;
  };

  const database = new PostgresDatabase(databaseUrl);
  try {
    await database.query(MIGRATIONS_TABLE_SQL);
    await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
    await database.query(`DELETE FROM vector_chunks WHERE collection = $1`, [COLLECTION]);

    const embedder = new HttpEmbedder(aiBase);
    const vectorStore = new PgVectorStore(database);

    for (const document of fixtures.documents) {
      const chunks = chunkText(document.body);
      const embedded = await embedder.embed(chunks);
      await vectorStore.upsert(
        chunks.map((text, index) => ({
          id: `${document.id}:${index}`,
          collection: COLLECTION,
          documentId: document.id,
          text,
          metadata: {
            documentId: document.id,
            title: document.title,
            approved: true,
            // Keep reads scoped to the model that produced the vectors.
            embeddingModel: embedded.modelVersion,
          },
          embedding: embedded.vectors[index] as number[],
        })),
      );
    }

    const retriever = new PgRetriever(embedder, vectorStore, 0.1, 0);
    // Same fixtures, both modes (18.T9): hybrid is production, vector-only is
    // the baseline the gate compares against.
    const ab = await evaluateRetrievalAb({
      collection: COLLECTION,
      queries: fixtures.queries,
      topK: TOP_K,
      gates: GATES,
      search: async (collection, query, opts) =>
        (await retriever.search(collection, query, { limit: opts.limit, hybrid: opts.hybrid }))
          .chunks,
    });
    const report = { generatedAt: new Date().toISOString(), ...ab };

    await mkdir(path.join(HERE, 'reports'), { recursive: true });
    await writeFile(
      path.join(HERE, 'reports/retrieval-latest.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          hybrid: { recallAt3: report.hybrid.recallAt3, mrr: report.hybrid.mrr },
          vectorOnly: { recallAt3: report.vectorOnly.recallAt3, mrr: report.vectorOnly.mrr },
          delta: report.delta,
          queries: report.queries,
        },
        null,
        2,
      ),
    );
    const failure = retrievalAbFailure(report);
    if (failure) {
      console.error(failure);
      return 1;
    }
    return 0;
  } finally {
    await database.close();
  }
}

void main().then((code) => process.exit(code));
