/**
 * Retrieval eval (Phase 4, CI gate): seeds fixture documents through the real
 * embedder + pgvector store, then measures recall@3 and MRR on labeled queries.
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
          metadata: { documentId: document.id, title: document.title, approved: true },
          embedding: embedded.vectors[index] as number[],
        })),
      );
    }

    const retriever = new PgRetriever(embedder, vectorStore, 0.1, 0);
    let hits = 0;
    let reciprocalRankSum = 0;
    const rows: Array<{
      query: string;
      expected: string;
      retrieved: string[];
      rank: number | null;
    }> = [];

    for (const item of fixtures.queries) {
      const result = await retriever.search(COLLECTION, item.query, { limit: TOP_K });
      const retrieved = result.chunks.map((chunk) => chunk.documentId);
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

    const recallAt3 = hits / fixtures.queries.length;
    const mrr = reciprocalRankSum / fixtures.queries.length;
    const report = {
      generatedAt: new Date().toISOString(),
      collection: COLLECTION,
      queries: fixtures.queries.length,
      topK: TOP_K,
      recallAt3: Number(recallAt3.toFixed(4)),
      mrr: Number(mrr.toFixed(4)),
      gates: GATES,
      results: rows,
    };

    await mkdir(path.join(HERE, 'reports'), { recursive: true });
    await writeFile(
      path.join(HERE, 'reports/retrieval-latest.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        { recallAt3: report.recallAt3, mrr: report.mrr, queries: report.queries },
        null,
        2,
      ),
    );
    if (recallAt3 < GATES.recallAt3) {
      console.error(`GATE FAILURE: recall@${TOP_K} ${recallAt3} < ${GATES.recallAt3}`);
      return 1;
    }
    return 0;
  } finally {
    await database.close();
  }
}

void main().then((code) => process.exit(code));
