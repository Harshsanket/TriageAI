/**
 * kb module (Phase 4): knowledge-base documents, approval, idempotent
 * ingestion into the pgvector collection, and approved-only search.
 * Embeddings + vector storage are capabilities; this module owns only its own
 * document bookkeeping tables.
 */
import { createHash } from 'node:crypto';

import { ulid } from 'ulid';
import { z } from 'zod';

import { chunkText } from '@triageai/rag';
import { AppError } from '@triageai/kernel';
import type { TriageModule } from '@triageai/kernel';

export { chunkText } from '@triageai/rag';

const configSchema = z
  .object({
    collection: z.string().default('kb_docs'),
  })
  .strict();

const MIGRATIONS = [
  {
    id: '0001-kb-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS kb_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        approved BOOLEAN NOT NULL DEFAULT false,
        version INT NOT NULL DEFAULT 0,
        sha256 TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS kb_ingest_runs (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
        version INT NOT NULL,
        status TEXT NOT NULL,
        chunk_count INT NOT NULL DEFAULT 0,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
    dropSql: 'DROP TABLE IF EXISTS kb_ingest_runs; DROP TABLE IF EXISTS kb_documents;',
  },
];

interface DocumentRow {
  [key: string]: unknown;
  id: string;
  title: string;
  body: string;
  source: string;
  approved: boolean;
  version: number;
  sha256: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const docDto = (row: DocumentRow) => ({
  id: row.id,
  title: row.title,
  source: row.source,
  approved: row.approved,
  version: row.version,
  sha256: row.sha256,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

export const kbModule: TriageModule = {
  id: 'kb',
  version: '0.1.0',
  capabilities: ['embedder', 'vectorStore', 'retriever'],
  dependsOn: {
    modules: [],
    capabilities: [
      { capability: 'embedder' },
      { capability: 'vectorStore' },
      { capability: 'retriever' },
    ],
  },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['kb_documents', 'kb_ingest_runs'],
  manifest: {
    routes: [{ path: '/kb', title: 'Knowledge base' }],
    nav: [{ label: 'Knowledge base', order: 30, path: '/kb' }],
    background: [],
  },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: 'documents + approved-only retrieval' }),
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const { collection } = options;

    const ingest = async (document: DocumentRow, force = false) => {
      const embedder = ctx.capabilities.embedder;
      const vectorStore = ctx.capabilities.vectorStore;
      if (!embedder || !vectorStore)
        throw new Error('kb requires embedder + vectorStore capabilities');

      const sha = createHash('sha256').update(document.body).digest('hex');
      if (!force && document.version > 0 && document.sha256 === sha) {
        return { changed: false, version: document.version, chunks: 0 };
      }

      const version = document.version + 1;
      const pieces = chunkText(document.body);
      const runId = ulid();
      try {
        await vectorStore.deleteByDocument(collection, document.id);
        for (let offset = 0; offset < pieces.length; offset += 32) {
          const batch = pieces.slice(offset, offset + 32);
          const embedded = await embedder.embed(batch);
          await vectorStore.upsert(
            batch.map((text, index) => ({
              id: `${document.id}:${version}:${offset + index}`,
              collection,
              documentId: document.id,
              text,
              metadata: {
                documentId: document.id,
                title: document.title,
                source: document.source,
                approved: document.approved,
                version,
              },
              embedding: embedded.vectors[index] as number[],
            })),
          );
        }
        await ctx.database.query(
          `UPDATE kb_documents SET version = $2, sha256 = $3, updated_at = now() WHERE id = $1`,
          [document.id, version, sha],
        );
        await ctx.database.query(
          `INSERT INTO kb_ingest_runs (id, document_id, version, status, chunk_count)
           VALUES ($1, $2, $3, 'succeeded', $4)`,
          [runId, document.id, version, pieces.length],
        );
        return { changed: true, version, chunks: pieces.length };
      } catch (err) {
        await ctx.database.query(
          `INSERT INTO kb_ingest_runs (id, document_id, version, status, error)
           VALUES ($1, $2, $3, 'failed', $4)`,
          [runId, document.id, version, (err as Error).message],
        );
        throw err;
      }
    };

    const loadDocument = async (id: string) => {
      const rows = await ctx.database.query<DocumentRow>(
        `SELECT * FROM kb_documents WHERE id = $1`,
        [id],
      );
      return rows[0];
    };

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/documents',
      handler: async (request) => {
        const body = z
          .object({
            title: z.string().min(1).max(300),
            body: z.string().min(1).max(200_000),
            source: z.string().min(1).max(300).default('manual'),
          })
          .parse(request.body);
        const id = ulid();
        await ctx.database.query(
          `INSERT INTO kb_documents (id, title, body, source, approved) VALUES ($1, $2, $3, $4, false)`,
          [id, body.title, body.body, body.source],
        );
        const document = (await loadDocument(id)) as DocumentRow;
        const result = await ingest(document);
        return { document: docDto(await loadDocument(id)), ingest: result };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/kb/documents',
      handler: async () => {
        const rows = await ctx.database.query<DocumentRow>(
          `SELECT * FROM kb_documents ORDER BY updated_at DESC LIMIT 200`,
        );
        return rows.map(docDto);
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/kb/documents/:id',
      handler: async (request) => {
        const document = await loadDocument(request.params.id);
        if (!document) throw new AppError('NOT_FOUND', 'document not found');
        return docDto(document);
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/documents/:id/approve',
      handler: async (request) => {
        const document = await loadDocument(request.params.id);
        if (!document) throw new AppError('NOT_FOUND', 'document not found');
        await ctx.database.query(
          `UPDATE kb_documents SET approved = true, updated_at = now() WHERE id = $1`,
          [document.id],
        );
        const approved = (await loadDocument(document.id)) as DocumentRow;
        // Re-upsert chunks so the `approved` metadata filter matches.
        const result = await ingest(approved, true);
        return { document: docDto(await loadDocument(document.id)), ingest: result };
      },
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/api/v1/kb/documents/:id',
      handler: async (request) => {
        const document = await loadDocument(request.params.id);
        if (!document) throw new AppError('NOT_FOUND', 'document not found');
        const vectorStore = ctx.capabilities.vectorStore;
        if (!vectorStore) throw new Error('kb requires a vectorStore capability');
        await vectorStore.deleteByDocument(collection, document.id);
        await ctx.database.query(`DELETE FROM kb_documents WHERE id = $1`, [document.id]);
        return { deleted: true, documentId: document.id };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/documents/:id/reingest',
      handler: async (request) => {
        const document = await loadDocument(request.params.id);
        if (!document) throw new AppError('NOT_FOUND', 'document not found');
        const result = await ingest(document);
        return { document: docDto(await loadDocument(document.id)), ingest: result };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/search',
      handler: async (request) => {
        const retriever = ctx.capabilities.retriever;
        if (!retriever) throw new Error('retriever capability is not configured');
        const body = z
          .object({
            query: z.string().min(1).max(2000),
            limit: z.number().int().positive().max(20).default(4),
          })
          .parse(request.body);
        const result = await retriever.search(collection, body.query, {
          limit: body.limit,
          filter: { approved: true },
        });
        return {
          chunks: result.chunks.map((chunk) => ({
            id: chunk.id,
            documentId: chunk.documentId,
            text: chunk.text,
            score: Number(chunk.score.toFixed(4)),
            metadata: chunk.metadata,
          })),
          gate: result.gate,
        };
      },
    });
  },
};
