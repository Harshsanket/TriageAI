/**
 * kb module (Phase 4, expanded in Phase 20): knowledge sources with hash
 * dedupe, per-source on/off, deterministic extraction, workflow ingestion and
 * hybrid search over enabled sources. Embeddings + storage are capabilities; this
 * module owns only its own source/document bookkeeping tables.
 */
import { ulid } from 'ulid';
import { z } from 'zod';

import {
  KbDocumentCreateRequestSchema,
  KbImportRequestSchema,
  KbManagedSourceUpsertSchema,
  KbSearchRequestSchema,
  KbSearchResponseSchema,
  KbSourceCreateRequestSchema,
  KbSourceListResponseSchema,
  KbStorageStatsSchema,
  KbSourceUpdateRequestSchema,
  type KbDocumentDto,
  type KbSourceDto,
} from '@triageai/contracts';
import { AppError, internal } from '@triageai/kernel';
import type { KernelContext, TriageModule } from '@triageai/kernel';

import {
  createSource,
  documentDto,
  embeddingKey,
  hashText,
  loadDocument,
  loadSource,
  readDataProcessing,
  registerIngestWorkflow,
  runIngest,
  toSourceDto,
  type DocumentRow,
  type SourceRow,
} from './ingest.js';
import { KB_MIGRATIONS } from './migrations.js';
import { createGitHubSource, createUrlSource } from './sources.js';

export { chunkDocument, chunkText } from '@triageai/rag';

const configSchema = z
  .object({
    collection: z.string().default('kb_docs'),
    /** Default source sensitivity; individual sources may be stricter. */
    sensitivity: z.enum(['public', 'internal', 'restricted', 'secret']).default('internal'),
  })
  .strict();

const KIND_LABELS: Record<string, string> = {
  note: 'Note',
  file: 'Document',
  url: 'Website',
  github: 'GitHub',
  plugin: 'Plugin',
};

export const kbModule: TriageModule = {
  id: 'kb',
  version: '0.1.0',
  capabilities: ['embedder', 'vectorStore', 'retriever', 'blobStore', 'egress'],
  permissions: {
    storage: { schema: true },
    routes: [
      { method: 'DELETE', path: '/api/v1/kb/documents/:id' },
      { method: 'DELETE', path: '/api/v1/kb/sources/:id' },
      { method: 'GET', path: '/api/v1/kb/documents' },
      { method: 'GET', path: '/api/v1/kb/documents/:id' },
      { method: 'GET', path: '/api/v1/kb/sources' },
      { method: 'GET', path: '/api/v1/kb/storage' },
      { method: 'PATCH', path: '/api/v1/kb/sources/:id' },
      { method: 'POST', path: '/api/v1/kb/documents' },
      { method: 'POST', path: '/api/v1/kb/documents/:id/reingest' },
      { method: 'POST', path: '/api/v1/kb/managed' },
      { method: 'POST', path: '/api/v1/kb/search' },
      { method: 'POST', path: '/api/v1/kb/sources' },
      { method: 'POST', path: '/api/v1/kb/sources/batch' },
    ],
    events: { publish: ['kb.source.ingested'], subscribe: [] },
    capabilities: {
      consume: ['embedder', 'vectorStore', 'retriever', 'blobStore', 'egress'],
      provide: [],
    },
    stages: ['kb.ingest.embed', 'kb.ingest.index', 'kb.ingest.prepare'],
    workflows: ['kb.ingest'],
    evals: [],
    tools: [],
    egress: { hosts: ['*'], dataClasses: ['public', 'internal', 'restricted'] },
    knowledge: { read: ['*'], write: ['*'] },
  },
  dependsOn: {
    capabilities: [
      { capability: 'embedder' },
      { capability: 'vectorStore' },
      { capability: 'retriever' },
      { capability: 'blobStore', optional: true },
      { capability: 'egress', optional: true },
    ],
  },
  configSchema,
  migrations: KB_MIGRATIONS,
  tables: ['kb_documents', 'kb_ingest_runs', 'kb_sources', 'kb_ingest_items'],
  manifest: {
    routes: [{ path: '/kb', title: 'Knowledge base' }],
    nav: [{ label: 'Knowledge base', order: 30, path: '/kb' }],
    background: [],
  },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: 'sources + hybrid retrieval' }),
    onUninstall: async ({ database, options, capabilities, knowledge }) => {
      const collection = typeof options.collection === 'string' ? options.collection : 'kb_docs';
      await knowledge.deleteCollection(collection);
      const blobs = await database
        .query<{ blob_ref: string }>(
          `SELECT DISTINCT blob_ref FROM kb_sources WHERE blob_ref IS NOT NULL`,
        )
        .catch(() => []);
      for (const row of blobs) {
        await capabilities.blobStore?.delete(row.blob_ref).catch(() => undefined);
      }
    },
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const { collection } = options;

    if (!ctx.knowledgeSources.get('url')) {
      ctx.registerKnowledgeSource(createUrlSource(ctx.capabilities.egress));
    }
    if (!ctx.knowledgeSources.get('github')) {
      ctx.registerKnowledgeSource(createGitHubSource(ctx.capabilities.egress));
    }
    registerIngestWorkflow(ctx, collection);

    ctx.registerDashboardProvider({
      id: 'kb',
      async read({ database }) {
        const counts = await database.query<{ documents: number }>(
          `SELECT COUNT(*)::int AS documents FROM kb_documents`,
        );
        const [sources, documents, chunks, ingest] = await Promise.all([
          database.query<{ bucket: string; count: number }>(
            `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket,
                    COUNT(*)::int AS count FROM kb_sources
              WHERE created_at > now() - interval '14 days' GROUP BY 1`,
          ),
          database.query<{ bucket: string; count: number }>(
            `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket,
                    COUNT(*)::int AS count FROM kb_documents
              WHERE created_at > now() - interval '14 days' GROUP BY 1`,
          ),
          ctx.knowledge.dailyCounts(collection, 14),
          database.query<{ total: number; failures: number }>(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status = 'failed')::int AS failures
               FROM kb_ingest_runs WHERE created_at > now() - interval '14 days'`,
          ),
        ]);
        const buckets = new Map<
          string,
          { bucket: string; sources: number; documents: number; chunks: number; datasets: number }
        >();
        const ensure = (bucket: string) => {
          const existing = buckets.get(bucket);
          if (existing) return existing;
          const created = { bucket, sources: 0, documents: 0, chunks: 0, datasets: 0 };
          buckets.set(bucket, created);
          return created;
        };
        for (const row of sources) ensure(row.bucket).sources += row.count;
        for (const row of documents) ensure(row.bucket).documents += row.count;
        for (const row of chunks) ensure(row.bucket).chunks += row.count;
        return {
          knowledge: {
            documents: counts[0]?.documents ?? 0,
            // Approval was removed in Phase 23.4; keep the DTO field at zero
            // until the next dashboard schema revision.
            pendingApproval: 0,
          },
          knowledgePoints: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
          ingestJobs: ingest[0]?.total ?? 0,
          ingestFailures: ingest[0]?.failures ?? 0,
        };
      },
    });

    const ownerOf = (request: { ownerScope?: string; actorId?: string }): string | null =>
      request.ownerScope ?? request.actorId ?? null;

    const documentResponse = async (
      documentId: string,
      ingest: Awaited<ReturnType<typeof runIngest>>,
    ) => {
      const document = await loadDocument(ctx, documentId);
      if (!document) throw new AppError('NOT_FOUND', 'document not found');
      return {
        document: documentDto(document),
        ingest: {
          changed: ingest.changed,
          version: ingest.version || document.version,
          chunks: ingest.chunks,
          deduped: ingest.deduped > 0,
          status: ingest.status,
          failed: ingest.failed,
        },
      };
    };

    const createFromRequest = async (
      input: z.infer<typeof KbSourceCreateRequestSchema>,
      ownerId: string | null,
    ) => {
      const label = input.label ?? KIND_LABELS[input.kind] ?? input.kind;
      if (input.kind === 'note' || input.kind === 'file') {
        if (input.kind === 'note' && !input.body) {
          throw new AppError('VALIDATION', 'a note needs a body', undefined, 400);
        }
        const bytes =
          input.kind === 'file' && input.contentBase64
            ? new Uint8Array(Buffer.from(input.contentBase64, 'base64'))
            : undefined;
        if (input.kind === 'file' && !bytes && !input.body) {
          throw new AppError(
            'VALIDATION',
            'a file needs contentBase64 or text body',
            undefined,
            400,
          );
        }
        const created = await createSource(ctx, {
          kind: input.kind,
          title: input.title,
          label,
          mediaType: input.mediaType ?? (input.kind === 'note' ? 'text/markdown' : null),
          sensitivity: input.sensitivity ?? options.sensitivity,
          ...(bytes ? { bytes } : {}),
          ...(input.body ? { body: input.body } : {}),
          ownerId,
        });
        return [created];
      }

      const type = input.kind === 'plugin' ? input.type : input.kind;
      if (!type) throw new AppError('VALIDATION', 'plugin sources need a type', undefined, 400);
      const source = ctx.knowledgeSources.get(type);
      if (!source) {
        throw new AppError(
          'kb.SOURCE_UNKNOWN',
          `no knowledge source plugin is registered for "${type}"`,
          undefined,
          404,
        );
      }
      const config = source.configSchema.parse({
        ...(input.config ?? {}),
        ...(input.kind === 'url' ? { url: input.url } : {}),
        ...(input.kind === 'github'
          ? { repo: input.repo, ref: input.ref, path: input.path, token: input.token }
          : {}),
      }) as Record<string, unknown>;
      const created: Array<Awaited<ReturnType<typeof createSource>>> = [];
      for await (const item of source.list(config)) {
        const bytes = await item.fetch();
        created.push(
          await createSource(ctx, {
            kind: type,
            title: input.title || item.name,
            label: input.label ?? source.label ?? KIND_LABELS[type] ?? type,
            uri: input.url ?? (input.repo ? `github:${input.repo}/${item.name}` : null),
            mediaType: item.mediaType,
            sensitivity: input.sensitivity ?? options.sensitivity,
            bytes,
            contentHash: item.contentHash,
            ownerId,
          }),
        );
      }
      if (created.length === 0) {
        throw new AppError('kb.SOURCE_EMPTY', 'the source returned no documents', undefined, 422);
      }
      return created;
    };

    const ingestCreated = async (
      created: Array<Awaited<ReturnType<typeof createSource>>>,
      title: string,
      ownerId: string | null,
    ) => {
      const pending = created.filter((item) => !item.deduped);
      const ingest = await runIngest(
        ctx,
        pending.map((item) => item.source.id),
        { collection, title, ownerId },
      );
      return {
        ingest: {
          ...ingest,
          deduped: ingest.deduped + created.filter((item) => item.deduped).length,
        },
        pending,
      };
    };

    // Legacy document route: one typed note, same pipeline under the hood.
    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/documents',
      handler: async (request) => {
        const body = KbDocumentCreateRequestSchema.parse(request.body);
        const ownerId = ownerOf(request);
        const created = await createSource(ctx, {
          kind: 'note',
          title: body.title,
          label: body.label ?? 'Note',
          mediaType: body.mediaType ?? 'text/markdown',
          sensitivity: options.sensitivity,
          body: body.body,
          ownerId,
        });
        const { ingest } = await ingestCreated([created], body.title, ownerId);
        return documentResponse(
          created.document.id,
          created.deduped
            ? {
                ...ingest,
                status: 'succeeded',
                version: created.document.version,
                deduped: 1,
              }
            : ingest,
        );
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/kb/documents',
      handler: async (request) => {
        const rows = await ctx.database.query<DocumentRow>(
          `SELECT * FROM kb_documents
            ${request.ownerScope ? 'WHERE owner_id = $1' : ''}
            ORDER BY updated_at DESC LIMIT 200`,
          request.ownerScope ? [request.ownerScope] : [],
        );
        return rows.map(documentDto);
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/kb/documents/:id',
      handler: async (request) => {
        const document = await loadDocument(ctx, request.params.id);
        if (!document) throw new AppError('NOT_FOUND', 'document not found');
        if (request.ownerScope && document.owner_id !== request.ownerScope) {
          throw new AppError('NOT_FOUND', 'document not found');
        }
        return documentDto(document);
      },
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/api/v1/kb/documents/:id',
      handler: async (request) => {
        const document = await loadDocument(ctx, request.params.id);
        if (!document) throw new AppError('NOT_FOUND', 'document not found');
        const documentSource = document.source_id
          ? await loadSource(ctx, document.source_id)
          : null;
        if (documentSource?.read_only && !String(request.actor ?? '').startsWith('system:')) {
          throw new AppError('FORBIDDEN', 'managed read-only sources cannot be deleted');
        }
        const vectorStore = ctx.capabilities.vectorStore;
        if (!vectorStore) throw internal('kb requires a vectorStore capability');
        await vectorStore.deleteByDocument(collection, document.id);
        await ctx.database.query(`DELETE FROM kb_documents WHERE id = $1`, [document.id]);
        if (document.source_id) {
          await ctx.database.query(`DELETE FROM kb_sources WHERE id = $1`, [document.source_id]);
        }
        ctx.capabilities.retriever?.invalidate?.();
        return { deleted: true, documentId: document.id };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/documents/:id/reingest',
      handler: async (request) => {
        const document = await loadDocument(ctx, request.params.id);
        if (!document) throw new AppError('NOT_FOUND', 'document not found');
        const source = document.source_id ? await loadSource(ctx, document.source_id) : null;
        const ingest = source
          ? await runIngest(ctx, [source.id], {
              collection,
              title: `Re-ingesting ${document.title}`,
              ownerId: document.owner_id,
            })
          : await runIngestFromDocument(ctx, collection, document);
        return documentResponse(document.id, ingest);
      },
    });

    // Source list: the `/kb` and `/config` pages filter this by name/type/label.
    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/kb/sources',
      handler: async (request) => {
        const query = z
          .object({
            q: z.string().max(200).optional(),
            kind: z.string().max(60).optional(),
            label: z.string().max(120).optional(),
            status: z.string().max(30).optional(),
            enabled: z.enum(['true', 'false']).optional(),
          })
          .parse(request.query ?? {});
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (request.ownerScope) {
          params.push(request.ownerScope);
          clauses.push(`owner_id = $${params.length}`);
        }
        if (query.q) {
          params.push(`%${query.q.replace(/[%_]/g, '\\$&')}%`);
          clauses.push(
            `(title ILIKE $${params.length} OR label ILIKE $${params.length} OR kind ILIKE $${params.length})`,
          );
        }
        for (const field of ['kind', 'label', 'status'] as const) {
          const value = query[field];
          if (value) {
            params.push(value);
            clauses.push(`${field} = $${params.length}`);
          }
        }
        if (query.enabled) {
          params.push(query.enabled === 'true');
          clauses.push(`enabled = $${params.length}`);
        }
        const rows = await ctx.database.query<SourceRow>(
          `SELECT * FROM kb_sources
            ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
            ORDER BY updated_at DESC LIMIT 500`,
          params,
        );
        return KbSourceListResponseSchema.parse({ sources: rows.map(toSourceDto) });
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/sources',
      handler: async (request) => {
        const input = KbSourceCreateRequestSchema.parse(request.body);
        const ownerId = ownerOf(request);
        const created = await createFromRequest(input, ownerId);
        const { ingest } = await ingestCreated(created, `Importing ${input.title}`, ownerId);
        const first = created[0] as Awaited<ReturnType<typeof createSource>>;
        return {
          source: toSourceDto((await loadSource(ctx, first.source.id)) as SourceRow),
          sources: created.map((item) => toSourceDto(item.source)),
          document: documentDto((await loadDocument(ctx, first.document.id)) as DocumentRow),
          ingest: {
            ...ingest,
            deduped: ingest.deduped + created.filter((item) => item.deduped).length,
          },
        };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/sources/batch',
      handler: async (request) => {
        const body = KbImportRequestSchema.parse(request.body);
        const ownerId = ownerOf(request);
        const created = [];
        for (const item of body.items) created.push(...(await createFromRequest(item, ownerId)));
        const { ingest } = await ingestCreated(
          created,
          `Importing ${created.length} files to ${body.collectionTitle}`,
          ownerId,
        );
        const sources: KbSourceDto[] = [];
        const documents: KbDocumentDto[] = [];
        for (const item of created) {
          const source = await loadSource(ctx, item.source.id);
          const document = await loadDocument(ctx, item.document.id);
          if (source) sources.push(toSourceDto(source));
          if (document) documents.push(documentDto(document));
        }
        return {
          sources,
          documents,
          ingest: {
            ...ingest,
            deduped: ingest.deduped + created.filter((item) => item.deduped).length,
          },
          jobId: ingest.runId,
        };
      },
    });

    ctx.registerRoute({
      method: 'PATCH',
      url: '/api/v1/kb/sources/:id',
      handler: async (request) => {
        const source = await loadSource(ctx, request.params.id);
        if (!source) throw new AppError('NOT_FOUND', 'source not found');
        if (request.ownerScope && source.owner_id !== request.ownerScope) {
          throw new AppError('NOT_FOUND', 'source not found');
        }
        const patch = KbSourceUpdateRequestSchema.parse(request.body ?? {});
        if (
          source.read_only &&
          patch.label !== undefined &&
          !String(request.actor ?? '').startsWith('system:')
        ) {
          throw new AppError('FORBIDDEN', 'managed read-only sources cannot be edited');
        }
        if (patch.label !== undefined) {
          await ctx.database.query(
            `UPDATE kb_sources SET label = $2, updated_at = now() WHERE id = $1`,
            [source.id, patch.label],
          );
        }
        if (patch.modelUse !== undefined) {
          await ctx.database.query(
            `UPDATE kb_sources SET model_use = $2, updated_at = now() WHERE id = $1`,
            [source.id, patch.modelUse],
          );
          for (const doc of await ctx.database.query<{ id: string }>(
            `SELECT id FROM kb_documents WHERE source_id = $1`,
            [source.id],
          )) {
            await ctx.capabilities.vectorStore?.updateMetadata?.(collection, doc.id, {
              modelUse: patch.modelUse,
            });
          }
        }
        if (patch.retentionDays !== undefined) {
          await ctx.database.query(
            `UPDATE kb_sources SET retention_days = $2, updated_at = now() WHERE id = $1`,
            [source.id, patch.retentionDays],
          );
        }
        if (patch.enabled !== undefined && patch.enabled !== source.enabled) {
          const docs = await ctx.database.query<{ id: string }>(
            `SELECT id FROM kb_documents WHERE source_id = $1`,
            [source.id],
          );
          await ctx.database.query(
            `UPDATE kb_sources SET enabled = $2, updated_at = now() WHERE id = $1`,
            [source.id, patch.enabled],
          );
          for (const doc of docs) {
            await ctx.capabilities.vectorStore?.updateMetadata?.(collection, doc.id, {
              sourceEnabled: patch.enabled,
            });
          }
          ctx.capabilities.retriever?.invalidate?.();
        }
        const updated = (await loadSource(ctx, source.id)) as SourceRow;
        return { source: toSourceDto(updated) };
      },
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/api/v1/kb/sources/:id',
      handler: async (request) => {
        const source = await loadSource(ctx, request.params.id);
        if (!source) throw new AppError('NOT_FOUND', 'source not found');
        if (request.ownerScope && source.owner_id !== request.ownerScope) {
          throw new AppError('NOT_FOUND', 'source not found');
        }
        if (source.read_only && !String(request.actor ?? '').startsWith('system:')) {
          throw new AppError('FORBIDDEN', 'managed read-only sources cannot be deleted');
        }
        const docs = await ctx.database.query<{ id: string }>(
          `SELECT id FROM kb_documents WHERE source_id = $1`,
          [source.id],
        );
        for (const doc of docs) {
          await ctx.capabilities.vectorStore?.deleteByDocument(collection, doc.id);
        }
        await ctx.database.query(`DELETE FROM kb_documents WHERE source_id = $1`, [source.id]);
        await ctx.database.query(`DELETE FROM kb_sources WHERE id = $1`, [source.id]);
        if (source.blob_ref) {
          const refs = await ctx.database.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM kb_sources WHERE blob_ref = $1`,
            [source.blob_ref],
          );
          if (Number(refs[0]?.count ?? 0) === 0) {
            await ctx.capabilities.blobStore?.delete(source.blob_ref).catch(() => undefined);
          }
        }
        ctx.capabilities.retriever?.invalidate?.();
        return { deleted: true, sourceId: source.id };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/kb/storage',
      handler: async () => {
        const processing = await readDataProcessing(ctx);
        const [sources, documents, knowledge, docStats, chunking, ingest, access, media, context] =
          await Promise.all([
            ctx.database.query<{ id: string; title: string; size_bytes: string }>(
              `SELECT id, title, size_bytes FROM kb_sources ORDER BY created_at DESC`,
            ),
            ctx.database.query<{ source_id: string | null; bytes: string }>(
              `SELECT source_id, COALESCE(SUM(octet_length(body)), 0)::bigint AS bytes
                 FROM kb_documents GROUP BY source_id`,
            ),
            ctx.knowledge.storageStats(collection),
            ctx.knowledge.documentStats(collection),
            ctx.database.query<{ label: string; value: number }>(
              `SELECT chunk_preset AS label, COUNT(*)::int AS value
                 FROM kb_sources GROUP BY 1 ORDER BY value DESC`,
            ),
            ctx.database.query<{ label: string; value: number }>(
              `SELECT status AS label, COUNT(*)::int AS value
                 FROM kb_ingest_runs GROUP BY 1 ORDER BY value DESC`,
            ),
            ctx.database.query<{ label: string; value: number }>(
              `SELECT CASE WHEN read_only THEN 'Read-only' ELSE 'Editable' END AS label,
                      COUNT(*)::int AS value
                 FROM kb_sources GROUP BY 1 ORDER BY value DESC`,
            ),
            ctx.database.query<{ label: string; value: number }>(
              `SELECT COALESCE(media_type, 'unknown') AS label, COUNT(*)::int AS value
                 FROM kb_sources GROUP BY 1 ORDER BY value DESC`,
            ),
            ctx.database.query<{ total: number; contextual: number }>(
              `SELECT COALESCE(SUM(jsonb_array_length(chunks)), 0)::int AS total,
                      COALESCE(SUM((
                        SELECT COUNT(*) FROM jsonb_array_elements(chunks) AS chunk
                         WHERE COALESCE(chunk->>'headingPath', '') <> ''
                      )), 0)::int AS contextual
                 FROM kb_ingest_items`,
            ),
          ]);
        const textBySource = new Map(
          documents.map((row) => [row.source_id ?? '', Number(row.bytes)]),
        );
        const perSource = sources.map((row) => ({
          id: row.id,
          title: row.title,
          bytes: Number(row.size_bytes) + (textBySource.get(row.id) ?? 0),
        }));
        const originalsBytes = sources.reduce((sum, row) => sum + Number(row.size_bytes), 0);
        const textBytes = documents.reduce((sum, row) => sum + Number(row.bytes), 0);
        const ingestTotal = ingest.reduce((sum, row) => sum + Number(row.value), 0);
        const ingestFailed = ingest
          .filter((row) => row.label === 'failed')
          .reduce((sum, row) => sum + Number(row.value), 0);
        const totalChunks = Number(context[0]?.total ?? 0);
        const contextualChunks = Math.min(totalChunks, Number(context[0]?.contextual ?? 0));
        const backends = [
          { label: 'Database', value: 'PostgreSQL' },
          {
            label: 'Vectors',
            value: `${ctx.config.capabilities.vectorStore?.adapter ?? 'pgvector'} (PostgreSQL)`,
          },
          {
            label: 'Queue',
            value:
              ctx.config.queue.adapter === 'bullmq'
                ? 'Redis (BullMQ)'
                : ctx.config.queue.adapter === 'inline'
                  ? 'In-process (inline)'
                  : 'PostgreSQL (pg-queue)',
          },
          {
            label: 'Files',
            value: ctx.capabilities.blobStore ? 'Blob store' : 'PostgreSQL text only',
          },
        ];
        return KbStorageStatsSchema.parse({
          totalBytes: originalsBytes + textBytes + knowledge.textBytes + knowledge.vectorBytes,
          originalsBytes,
          textBytes,
          chunksBytes: knowledge.textBytes,
          vectorBytes: knowledge.vectorBytes,
          documents: docStats.documents,
          chunks: knowledge.chunks,
          sources: perSource,
          backends,
          processing: {
            chunkStrategies: chunking,
            ingestStatus: ingest,
            accessModes: access,
            mediaTypes: media,
            contextualChunks,
            totalChunks,
            contextualRate:
              totalChunks === 0 ? 0 : Number(((contextualChunks / totalChunks) * 100).toFixed(1)),
            errorRate:
              ingestTotal === 0 ? 0 : Number(((ingestFailed / ingestTotal) * 100).toFixed(1)),
            pdfExtraction:
              processing.pdfExtraction === 'ocr'
                ? 'OCR (requires the AI service OCR adapter)'
                : processing.pdfExtraction === 'text-layer-strict'
                  ? 'deterministic text layer (rejects scans)'
                  : 'deterministic text layer (no OCR)',
          },
        });
      },
    });

    // System-only managed-source upsert (ADR-0056/0057). The host derives the
    // body (setup identity or an operational snapshot); this route keeps the
    // same source id and On/Off state, and only creates a new document version
    // when the content hash changes.
    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/managed',
      handler: async (request) => {
        if (!String(request.actor ?? '').startsWith('system:')) {
          throw new AppError('FORBIDDEN', 'managed KB sources are written by the host only');
        }
        const input = KbManagedSourceUpsertSchema.parse(request.body);
        const processing = await readDataProcessing(ctx);
        const contentHash = hashText(input.body);
        const label = input.label ?? 'Setup context';
        const existingRows = await ctx.database.query<SourceRow>(
          `SELECT * FROM kb_sources WHERE managed_key = $1 LIMIT 1`,
          [input.managedKey],
        );
        let source = existingRows[0];
        let created = false;
        if (!source) {
          const sourceId = ulid();
          const documentId = ulid();
          await ctx.database.query(
            `INSERT INTO kb_sources
               (id, title, kind, label, content_hash, embedding_model, chunk_preset,
                extraction_method, sensitivity, audience, managed_key, read_only, enabled,
                status, item_count, size_bytes)
             VALUES ($1,$2,'note',$3,$4,$5,$6,'direct',$7,$8,$9,true,$10,'pending',1,$11)`,
            [
              sourceId,
              input.title,
              label,
              contentHash,
              embeddingKey(ctx),
              processing.chunking,
              input.sensitivity,
              input.audience,
              input.managedKey,
              input.enabled ?? true,
              Buffer.byteLength(input.body, 'utf8'),
            ],
          );
          await ctx.database.query(
            `INSERT INTO kb_documents
               (id, title, body, source, source_id, label, media_type)
             VALUES ($1,$2,$3,'managed',$4,$5,'text/markdown')`,
            [documentId, input.title, input.body, sourceId, label],
          );
          source = (await loadSource(ctx, sourceId)) as SourceRow;
          created = true;
        } else {
          const changed = source.content_hash !== contentHash;
          await ctx.database.query(
            `UPDATE kb_sources
                SET title = $2, label = $3, sensitivity = $4, audience = $5,
                    read_only = true, enabled = COALESCE($6, enabled), updated_at = now()
                    ${changed ? `, content_hash = $7, status = 'pending'` : ''}
              WHERE id = $1`,
            [
              source.id,
              input.title,
              label,
              input.sensitivity,
              input.audience,
              input.enabled ?? null,
              ...(changed ? [contentHash] : []),
            ],
          );
          if (changed) {
            await ctx.database.query(
              `UPDATE kb_documents SET title = $2, body = $3, updated_at = now()
                WHERE source_id = $1`,
              [source.id, input.title, input.body],
            );
          }
          source = (await loadSource(ctx, source.id)) as SourceRow;
        }

        const changed = created || existingRows[0]?.content_hash !== contentHash;
        const needsIngest = created || changed || source.status !== 'ready';
        const before = await ctx.database.query<DocumentRow>(
          `SELECT * FROM kb_documents WHERE source_id = $1 LIMIT 1`,
          [source.id],
        );
        const ingest = needsIngest
          ? await runIngest(ctx, [source.id], {
              collection,
              title: `Refreshing ${input.title}`,
            })
          : {
              runId: null,
              status: 'succeeded' as const,
              changed: false,
              version: Number(before[0]?.version ?? 0),
              chunks: 0,
              failed: 0,
              deduped: 0,
              documents: [],
            };
        const documentRow = needsIngest
          ? await ctx.database.query<DocumentRow>(
              `SELECT * FROM kb_documents WHERE source_id = $1 LIMIT 1`,
              [source.id],
            )
          : before;
        return {
          source: toSourceDto((await loadSource(ctx, source.id)) as SourceRow),
          document: documentRow[0] ? documentDto(documentRow[0]) : null,
          ingest,
          changed,
        };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/kb/search',
      handler: async (request) => {
        const retriever = ctx.capabilities.retriever;
        if (!retriever) throw internal('retriever capability is not configured');
        const body = KbSearchRequestSchema.parse(request.body);
        const result = await retriever.search(collection, body.query, {
          limit: body.limit,
          filter: { sourceEnabled: true },
        });
        return KbSearchResponseSchema.parse({
          chunks: result.chunks.map((chunk) => ({
            id: chunk.id,
            documentId: chunk.documentId,
            text: chunk.text,
            score: Number(chunk.score.toFixed(4)),
            metadata: chunk.metadata,
          })),
          gate: result.gate,
        });
      },
    });
    ctx.registerRetentionTask({
      id: 'kb.sources',
      apply: async ({ database }) => {
        const expired = await database.query<{ id: string; blob_ref: string | null }>(
          `SELECT id, blob_ref FROM kb_sources
            WHERE retention_days IS NOT NULL
              AND created_at < now() - (retention_days || ' days')::interval`,
        );
        for (const source of expired) {
          const docs = await database.query<{ id: string }>(
            `SELECT id FROM kb_documents WHERE source_id = $1`,
            [source.id],
          );
          for (const doc of docs) {
            await ctx.capabilities.vectorStore?.deleteByDocument(collection, doc.id);
          }
          await database.query(`DELETE FROM kb_ingest_items WHERE source_id = $1`, [source.id]);
          await database.query(`DELETE FROM kb_documents WHERE source_id = $1`, [source.id]);
          await database.query(`DELETE FROM kb_sources WHERE id = $1`, [source.id]);
          if (source.blob_ref) {
            const refs = await database.query<{ count: string }>(
              `SELECT COUNT(*)::text AS count FROM kb_sources WHERE blob_ref = $1`,
              [source.blob_ref],
            );
            if (Number(refs[0]?.count ?? 0) === 0) {
              await ctx.capabilities.blobStore?.delete(source.blob_ref).catch(() => undefined);
            }
          }
        }
        return expired.length;
      },
    });
  },
};

async function runIngestFromDocument(
  ctx: KernelContext,
  collection: string,
  document: DocumentRow,
): Promise<Awaited<ReturnType<typeof runIngest>>> {
  // Legacy documents created before sources existed: give them a source first.
  const model = embeddingKey(ctx);
  const processing = await readDataProcessing(ctx);
  const { createHash } = await import('node:crypto');
  const sourceId = `legacy_${document.id}`;
  await ctx.database.query(
    `INSERT INTO kb_sources
       (id, title, kind, label, content_hash, embedding_model, chunk_preset, extraction_method,
        status, sensitivity)
     VALUES ($1,$2,'note','Note',$3,$4,$5,'direct','pending','internal')
     ON CONFLICT (id) DO NOTHING`,
    [
      sourceId,
      document.title,
      createHash('sha256').update(document.body).digest('hex'),
      model,
      processing.chunking,
    ],
  );
  await ctx.database.query(`UPDATE kb_documents SET source_id = $2 WHERE id = $1`, [
    document.id,
    sourceId,
  ]);
  return runIngest(ctx, [sourceId], { collection, title: `Re-ingesting ${document.title}` });
}

export { documentDto } from './ingest.js';
