/**
 * Knowledge ingestion pipeline (Phase 20.1/20.2, ADR-0051): hash/dedupe →
 * extract → chunk → embed → index. Registered as the `kb.ingest` workflow so
 * every stage records a decision and `run.progress` drives the jobs tray.
 */
import { createHash } from 'node:crypto';

import { ulid } from 'ulid';

import { KbDataProcessingSchema, KbDocumentDtoSchema } from '@triageai/contracts';
import type { KbDataProcessing } from '@triageai/contracts';
import type { KernelContext, StageHandlerContext } from '@triageai/kernel';
import { AppError, internal } from '@triageai/kernel';
import { chunkByPreset, extractText, type DocumentChunk } from '@triageai/rag';

export const CHUNK_PRESET = 'structure-700';
export const DATA_PROCESSING_KEY = 'dataProcessing';
const BATCH = 32;
const WAIT_MS = 30_000;

export interface SourceRow {
  [key: string]: unknown;
  id: string;
  title: string;
  kind: string;
  label: string;
  uri: string | null;
  media_type: string | null;
  content_hash: string;
  embedding_model: string;
  chunk_preset: string;
  extraction_method: string;
  sensitivity: 'public' | 'internal' | 'restricted' | 'secret';
  audience: 'public' | 'operator';
  managed_key: string | null;
  read_only: boolean;
  model_use: 'send' | 'redact' | 'withhold';
  retention_days: number | null;
  enabled: boolean;
  status: 'pending' | 'ready' | 'partial' | 'failed';
  item_count: number;
  size_bytes: number;
  blob_ref: string | null;
  owner_id: string | null;
  last_sync_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface DocumentRow {
  [key: string]: unknown;
  id: string;
  title: string;
  body: string;
  source: string;
  version: number;
  sha256: string | null;
  source_id: string | null;
  label: string | null;
  media_type: string | null;
  owner_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface IngestItemRow {
  [key: string]: unknown;
  id: string;
  run_id: string;
  source_id: string;
  document_id: string;
  position: number;
  text: string | null;
  chunks: DocumentChunk[];
  chunk_count: number;
  status: 'pending' | 'ready' | 'embedded' | 'succeeded' | 'failed' | 'skipped';
  error: string | null;
}

export interface SourceCreateInput {
  kind: string;
  title: string;
  label?: string;
  uri?: string | null;
  mediaType?: string | null;
  sensitivity?: SourceRow['sensitivity'];
  audience?: SourceRow['audience'];
  managedKey?: string | null;
  readOnly?: boolean;
  body?: string;
  bytes?: Uint8Array;
  contentHash?: string;
  itemCount?: number;
  ownerId?: string | null;
}

export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

export function hashText(text: string): string {
  return createHash('sha256').update(normalizeText(text)).digest('hex');
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function embeddingKey(ctx: KernelContext): string {
  return ctx.env.EMBEDDING_MODEL ?? ctx.env.AI_EMBEDDING_MODEL ?? 'default';
}

export async function readDataProcessing(ctx: KernelContext): Promise<KbDataProcessing> {
  const stored = await ctx.settings.get<unknown>(DATA_PROCESSING_KEY).catch(() => null);
  const parsed = KbDataProcessingSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : KbDataProcessingSchema.parse({});
}

export function extractionMethodFor(
  mediaType: string | null | undefined,
  kind: string,
  processing: KbDataProcessing,
): string {
  const type = (mediaType ?? '').toLowerCase();
  if (type === 'application/pdf') return processing.pdfExtraction;
  if (type.startsWith('image/')) return processing.imageExtraction;
  return baseExtraction(mediaType, kind);
}

function baseExtraction(mediaType: string | null | undefined, kind: string): string {
  const type = (mediaType ?? '').toLowerCase();
  if (type === 'application/pdf') return 'text-layer';
  if (type.startsWith('image/')) return 'skip';
  if (type.includes('wordprocessingml')) return 'docx-xml';
  if (type.includes('spreadsheetml')) return 'xlsx-xml';
  if (type === 'text/html') return 'html-text';
  if (type.startsWith('text/') || type === 'application/json') return 'direct';
  if (kind === 'note' || kind === 'url' || kind === 'github') return 'direct';
  return 'best-effort';
}

/** Where each source lives: metadata/text in Postgres, embeddings in pgvector,
 * original bytes in the blob store when one was captured. */
export function storageForSource(row: SourceRow): string[] {
  const labels = ['PostgreSQL'];
  if (row.blob_ref) labels.push('Blob store');
  if (row.status === 'ready' || row.status === 'partial') labels.push('pgvector');
  return labels;
}

export function documentDto(row: DocumentRow) {
  return KbDocumentDtoSchema.parse({
    id: row.id,
    title: row.title,
    source: row.source,
    version: row.version,
    sha256: row.sha256,
    sourceId: row.source_id,
    label: row.label,
    mediaType: row.media_type,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}

export function toSourceDto(row: SourceRow) {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    label: row.label,
    uri: row.uri,
    mediaType: row.media_type,
    contentHash: row.content_hash,
    enabled: row.enabled,
    status: row.status,
    itemCount: row.item_count,
    sizeBytes: Number(row.size_bytes ?? 0),
    sensitivity: row.sensitivity,
    audience: row.audience ?? 'public',
    managedKey: row.managed_key ?? null,
    readOnly: Boolean(row.read_only),
    chunkPreset: row.chunk_preset ?? CHUNK_PRESET,
    extraction:
      row.extraction_method && row.extraction_method !== 'text-layer'
        ? row.extraction_method
        : baseExtraction(row.media_type, row.kind),
    storage: storageForSource(row),
    modelUse: row.model_use ?? 'redact',
    retentionDays: row.retention_days == null ? null : Number(row.retention_days),
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function createSource(
  ctx: KernelContext,
  input: SourceCreateInput,
): Promise<{ source: SourceRow; document: DocumentRow; deduped: boolean }> {
  const model = embeddingKey(ctx);
  const processing = await readDataProcessing(ctx);
  const chunkPreset = processing.chunking;
  const extractionMethod = extractionMethodFor(input.mediaType, input.kind, processing);
  const body = input.body === undefined ? '' : normalizeText(input.body);
  const bytes = input.bytes;
  const contentHash =
    input.contentHash ??
    (bytes ? hashBytes(bytes) : hashText(body || `${input.kind}:${input.title}`));

  const existing = await findDuplicate(ctx, contentHash, model, chunkPreset);
  if (existing) return { ...existing, deduped: true };

  let blobRef: string | null = null;
  let size = Buffer.byteLength(body, 'utf8');
  if (bytes) {
    size = bytes.byteLength;
    if (ctx.capabilities.blobStore) {
      const stored = await ctx.capabilities.blobStore.put(bytes, {
        contentType: input.mediaType ?? 'application/octet-stream',
      });
      blobRef = stored.ref;
    } else if (!body) {
      throw new AppError(
        'kb.BLOB_STORE_OFF',
        'file sources need a blob store; set TRIAGEAI_BLOB_ROOT or upload text instead',
        undefined,
        503,
      );
    }
  }

  const sourceId = ulid();
  const documentId = ulid();
  try {
    await ctx.database.query(
      `INSERT INTO kb_sources
         (id, title, kind, label, uri, media_type, content_hash, embedding_model, chunk_preset,
          extraction_method, sensitivity, audience, managed_key, read_only, status, item_count,
          size_bytes, blob_ref, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16,$17,$18)`,
      [
        sourceId,
        input.title,
        input.kind,
        input.label ?? input.kind,
        input.uri ?? null,
        input.mediaType ?? null,
        contentHash,
        model,
        chunkPreset,
        extractionMethod,
        input.sensitivity ?? 'internal',
        input.audience ?? 'public',
        input.managedKey ?? null,
        input.readOnly ?? false,
        input.itemCount ?? 1,
        size,
        blobRef,
        input.ownerId ?? null,
      ],
    );
    await ctx.database.query(
      `INSERT INTO kb_documents
         (id, title, body, source, source_id, label, media_type, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        documentId,
        input.title,
        body,
        input.kind,
        sourceId,
        input.label ?? input.kind,
        input.mediaType ?? null,
        input.ownerId ?? null,
      ],
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const raced = await findDuplicate(ctx, contentHash, model, chunkPreset);
      if (raced) return { ...raced, deduped: true };
      // The source still exists but its document was deleted; reuse it instead
      // of failing the unique dedupe index.
      const sources = await ctx.database.query<SourceRow>(
        `SELECT * FROM kb_sources
          WHERE content_hash = $1 AND embedding_model = $2 AND chunk_preset = $3
            AND status IN ('pending','ready','partial')
          LIMIT 1`,
        [contentHash, model, chunkPreset],
      );
      const orphan = sources[0];
      if (orphan) {
        const documentId = ulid();
        await ctx.database.query(
          `INSERT INTO kb_documents
             (id, title, body, source, source_id, label, media_type, owner_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            documentId,
            input.title,
            body,
            input.kind,
            orphan.id,
            input.label ?? input.kind,
            input.mediaType ?? null,
            input.ownerId ?? null,
          ],
        );
        return {
          source: orphan,
          document: (await loadDocument(ctx, documentId)) as DocumentRow,
          deduped: false,
        };
      }
    }
    throw err;
  }
  const source = (await loadSource(ctx, sourceId)) as SourceRow;
  const document = (await loadDocument(ctx, documentId)) as DocumentRow;
  return { source, document, deduped: false };
}

async function findDuplicate(
  ctx: KernelContext,
  contentHash: string,
  model: string,
  chunkPreset: string,
): Promise<{ source: SourceRow; document: DocumentRow; deduped: boolean } | null> {
  const rows = await ctx.database.query<SourceRow & { document_id: string }>(
    `SELECT s.*, d.id AS document_id
       FROM kb_sources s JOIN kb_documents d ON d.source_id = s.id
      WHERE s.content_hash = $1 AND s.embedding_model = $2 AND s.chunk_preset = $3
        AND s.status IN ('pending','ready','partial')
      LIMIT 1`,
    [contentHash, model, chunkPreset],
  );
  const source = rows[0];
  if (!source) return null;
  const document = await loadDocument(ctx, source.document_id);
  if (!document) return null;
  return { source, document, deduped: true };
}

export async function loadSource(ctx: KernelContext, id: string): Promise<SourceRow | undefined> {
  const rows = await ctx.database.query<SourceRow>(`SELECT * FROM kb_sources WHERE id = $1`, [id]);
  return rows[0];
}

export async function loadDocument(
  ctx: KernelContext,
  id: string,
): Promise<DocumentRow | undefined> {
  const rows = await ctx.database.query<DocumentRow>(`SELECT * FROM kb_documents WHERE id = $1`, [
    id,
  ]);
  return rows[0];
}

export interface IngestSummary {
  runId: string | null;
  status: 'succeeded' | 'queued' | 'failed';
  changed: boolean;
  version: number;
  chunks: number;
  failed: number;
  deduped: number;
  documents: Array<{ documentId: string; version: number; chunks: number }>;
}

export async function runIngest(
  ctx: KernelContext,
  sourceIds: string[],
  opts: { collection: string; title?: string; ownerId?: string | null } = {
    collection: 'kb_docs',
  },
): Promise<IngestSummary> {
  if (sourceIds.length === 0) {
    return {
      runId: null,
      status: 'succeeded',
      changed: false,
      version: 0,
      chunks: 0,
      failed: 0,
      deduped: 0,
      documents: [],
    };
  }
  const started = await ctx.queue.startWorkflow(
    'kb.ingest',
    { sourceIds },
    {
      title:
        opts.title ??
        `Importing ${sourceIds.length} item${sourceIds.length === 1 ? '' : 's'} to ${opts.collection}`,
      ownerId: opts.ownerId ?? null,
      total: sourceIds.length,
      unit: 'items',
      waitMs: WAIT_MS,
    },
  );
  const run = await ctx.runs.get(started.runId);
  const output = (run?.run.output ?? null) as Record<string, Record<string, unknown>> | null;
  const summary = output?.index ?? {};
  if (run?.run.status === 'FAILED') {
    await markRunFailed(ctx, started.runId);
    return {
      runId: started.runId,
      status: 'failed',
      changed: false,
      version: 0,
      chunks: 0,
      failed: sourceIds.length,
      deduped: 0,
      documents: [],
    };
  }
  if (run?.run.status !== 'SUCCEEDED') {
    return {
      runId: started.runId,
      status: 'queued',
      changed: false,
      version: 0,
      chunks: 0,
      failed: 0,
      deduped: 0,
      documents: [],
    };
  }
  return {
    runId: started.runId,
    status: (summary.failed as number) > 0 ? 'failed' : 'succeeded',
    changed: (summary.imported as number) > 0,
    version: Number(summary.maxVersion ?? 0),
    chunks: Number(summary.chunks ?? 0),
    failed: Number(summary.failed ?? 0),
    deduped: Number(summary.skipped ?? 0),
    documents: (summary.documents as IngestSummary['documents']) ?? [],
  };
}

async function markRunFailed(ctx: KernelContext, runId: string): Promise<void> {
  await ctx.database.query(
    `UPDATE kb_sources SET status = 'failed', updated_at = now()
      WHERE id IN (SELECT source_id FROM kb_ingest_items WHERE run_id = $1 AND status <> 'succeeded')`,
    [runId],
  );
}

/** Register stage handlers and the workflow definition. */
export function registerIngestWorkflow(ctx: KernelContext, collection: string): void {
  ctx.registerStageHandler('kb.ingest.prepare', {
    async execute(stage) {
      const sourceIds = (stage.input.sourceIds as string[]) ?? [];
      let failed = 0;
      for (let index = 0; index < sourceIds.length; index++) {
        const sourceId = sourceIds[index] as string;
        try {
          const source = await loadSource(ctx, sourceId);
          if (!source) throw internal('source row missing');
          const documentRows = await ctx.database.query<DocumentRow>(
            `SELECT * FROM kb_documents WHERE source_id = $1`,
            [sourceId],
          );
          const document = documentRows[0];
          if (!document) throw internal('document row missing');
          const mediaType = (source.media_type ?? '').toLowerCase();
          let text = document.body;
          if (mediaType.startsWith('image/')) {
            if (source.extraction_method === 'skip') {
              throw internal('image extraction is off for this source');
            }
            if (source.extraction_method === 'metadata') text = `[Image: ${source.title}]`;
          }
          if (!text.trim() && source.blob_ref) {
            const blobStore = ctx.capabilities.blobStore;
            if (!blobStore) throw internal('blob store unavailable');
            const bytes = await blobStore.get(source.blob_ref);
            const extracted = extractText(bytes, source.media_type ?? 'text/plain');
            text = extracted.text;
            if (!text.trim()) {
              if (source.extraction_method === 'ocr') {
                throw internal(
                  'OCR extraction is not available in this build; install the optional AI service OCR adapter',
                );
              }
              if (mediaType === 'application/pdf') {
                throw internal('PDF has no text layer; upload a text-based PDF or enable OCR');
              }
              throw internal('no text layer found');
            }
            await ctx.database.query(`UPDATE kb_documents SET body = $2 WHERE id = $1`, [
              document.id,
              text,
            ]);
          }
          if (!text.trim()) throw internal('source has no extractable text');
          const chunks = chunkByPreset(text, source.chunk_preset);
          await ctx.database.query(
            `INSERT INTO kb_ingest_items
               (id, run_id, source_id, document_id, position, text, chunks, chunk_count, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready')
             ON CONFLICT (run_id, source_id) DO UPDATE
               SET text = EXCLUDED.text, chunks = EXCLUDED.chunks,
                   chunk_count = EXCLUDED.chunk_count, status = 'ready', error = NULL,
                   updated_at = now()`,
            [ulid(), stage.runId, sourceId, document.id, index, text, chunks, chunks.length],
          );
        } catch (err) {
          failed += 1;
          await markItemFailed(stage, sourceId, (err as Error).message);
        }
        await stage.reportProgress({
          done: index + 1,
          total: sourceIds.length,
          stage: 'extracting',
          unit: 'items',
        });
      }
      return {
        output: { prepared: sourceIds.length - failed, failed },
        deterministic: { sourceIds, failed },
      };
    },
  });

  ctx.registerStageHandler('kb.ingest.embed', {
    async execute(stage) {
      const embedder = ctx.capabilities.embedder;
      const vectorStore = ctx.capabilities.vectorStore;
      if (!embedder || !vectorStore) {
        throw internal('kb requires embedder + vectorStore capabilities');
      }
      const items = await ctx.database.query<IngestItemRow>(
        `SELECT * FROM kb_ingest_items WHERE run_id = $1 AND status = 'ready' ORDER BY position`,
        [stage.runId],
      );
      let failed = 0;
      for (let index = 0; index < items.length; index++) {
        const item = items[index] as IngestItemRow;
        try {
          const source = await loadSource(ctx, item.source_id);
          const document = await loadDocument(ctx, item.document_id);
          if (!source || !document) throw internal('source or document disappeared');
          const version = Number(document.version) + 1;
          const chunks = item.chunks as DocumentChunk[];
          const embedded: Array<{ text: string; headingPath: string; vector: number[] }> = [];
          let modelVersion = 'default';
          for (let offset = 0; offset < chunks.length; offset += BATCH) {
            const batch = chunks.slice(offset, offset + BATCH);
            const result = await embedder.embed(batch.map((piece) => piece.text));
            modelVersion = result.modelVersion;
            batch.forEach((piece, batchIndex) =>
              embedded.push({
                text: piece.text,
                headingPath: piece.headingPath,
                vector: result.vectors[batchIndex] as number[],
              }),
            );
            await stage.reportProgress({
              done: index,
              total: items.length,
              stage: `embedding ${source.title} (${Math.min(offset + BATCH, chunks.length)}/${chunks.length})`,
              unit: 'items',
            });
          }
          // Delete the previous version only after every new vector exists.
          await vectorStore.deleteByDocument(collection, document.id);
          for (let offset = 0; offset < embedded.length; offset += BATCH) {
            const batch = embedded.slice(offset, offset + BATCH);
            await vectorStore.upsert(
              batch.map((piece, batchIndex) => ({
                id: `${document.id}:${version}:${offset + batchIndex}`,
                collection,
                documentId: document.id,
                text: piece.text,
                metadata: {
                  documentId: document.id,
                  sourceId: source.id,
                  sourceEnabled: source.enabled,
                  sourceKind: source.kind,
                  title: document.title,
                  source: document.source,
                  label: source.label,
                  sensitivity: source.sensitivity,
                  audience: source.audience ?? 'public',
                  modelUse: source.model_use ?? 'redact',
                  managedKey: source.managed_key ?? null,
                  readOnly: Boolean(source.read_only),
                  version,
                  headingPath: piece.headingPath,
                  updatedAt: new Date().toISOString(),
                  embeddingModel: modelVersion,
                },
                embedding: piece.vector,
              })),
            );
          }
          // A toggle may have landed while this item was embedding. Re-read the
          // source after the upsert and let the newer state win; otherwise new
          // chunks would carry the stale `sourceEnabled` value and a source the
          // operator just turned off would stay searchable.
          const current = await loadSource(ctx, item.source_id);
          if (current && current.enabled !== source.enabled) {
            await vectorStore.updateMetadata?.(collection, document.id, {
              sourceEnabled: current.enabled,
            });
          }
          await ctx.database.query(
            `UPDATE kb_ingest_items SET status = 'embedded', chunk_count = $2, updated_at = now()
             WHERE id = $1`,
            [item.id, embedded.length],
          );
        } catch (err) {
          failed += 1;
          await markItemFailed(stage, item.source_id, (err as Error).message);
        }
        await stage.reportProgress({
          done: index + 1,
          total: items.length,
          stage: 'embedding',
          unit: 'items',
        });
      }
      return { output: { embedded: items.length - failed, failed }, deterministic: { failed } };
    },
  });

  ctx.registerStageHandler('kb.ingest.index', {
    async execute(stage) {
      const items = await ctx.database.query<IngestItemRow>(
        `SELECT * FROM kb_ingest_items WHERE run_id = $1 ORDER BY position`,
        [stage.runId],
      );
      const documents: IngestSummary['documents'] = [];
      let failed = 0;
      let skipped = 0;
      let maxVersion = 0;
      for (const item of items) {
        if (item.status === 'failed') {
          failed += 1;
          const source = await loadSource(ctx, item.source_id);
          if (source) {
            await ctx.database.query(
              `INSERT INTO kb_ingest_runs (id, document_id, version, status, error)
               VALUES ($1,$2,$3,'failed',$4)`,
              [ulid(), item.document_id, source.item_count, item.error?.slice(0, 500) ?? 'failed'],
            );
            await ctx.database.query(
              `UPDATE kb_sources SET status = 'failed', updated_at = now() WHERE id = $1`,
              [source.id],
            );
          }
          continue;
        }
        if (item.status !== 'embedded') {
          skipped += 1;
          continue;
        }
        const source = await loadSource(ctx, item.source_id);
        const document = await loadDocument(ctx, item.document_id);
        if (!source || !document) {
          failed += 1;
          continue;
        }
        const version = Number(document.version) + 1;
        await ctx.database.query(
          `UPDATE kb_documents
              SET version = $2, sha256 = $3, updated_at = now()
            WHERE id = $1`,
          [document.id, version, source.content_hash],
        );
        await ctx.database.query(
          `INSERT INTO kb_ingest_runs (id, document_id, version, status, chunk_count)
           VALUES ($1,$2,$3,'succeeded',$4)`,
          [ulid(), document.id, version, item.chunk_count],
        );
        await ctx.database.query(
          `UPDATE kb_sources
              SET status = 'ready', last_sync_at = now(), updated_at = now()
            WHERE id = $1`,
          [source.id],
        );
        await ctx.database.query(
          `UPDATE kb_ingest_items SET status = 'succeeded', updated_at = now() WHERE id = $1`,
          [item.id],
        );
        if (
          ctx.enabledModules.includes('data-extract') &&
          item.text &&
          item.text.length <= 500_000
        ) {
          await ctx.events.publish('kb.source.ingested', {
            sourceId: source.id,
            title: document.title,
            text: item.text,
            mediaType: source.media_type,
            ownerId: source.owner_id,
          });
        }
        documents.push({ documentId: document.id, version, chunks: item.chunk_count });
        maxVersion = Math.max(maxVersion, version);
      }
      // New or superseded chunks must be visible to the next retrieval; cached
      // chunk lists and generated answers from before this ingest are stale.
      if (documents.length > 0) ctx.capabilities.retriever?.invalidate?.();
      const chunks = documents.reduce((sum, document) => sum + document.chunks, 0);
      const summary = {
        imported: documents.length,
        failed,
        skipped,
        chunks,
        maxVersion,
        documents,
      };
      await stage.reportProgress({
        done: items.length,
        total: items.length,
        stage: 'done',
        unit: 'items',
        ...(failed > 0 ? { status: 'partial' as const } : {}),
      });
      return { output: summary, deterministic: { ...summary } };
    },
  });

  ctx.queue.start({
    id: 'kb.ingest',
    version: '0.2.0',
    module: 'kb',
    trigger: { type: 'manual' },
    stages: [
      { id: 'prepare', kind: 'kb.ingest.prepare', input: { sourceIds: '$.sourceIds' } },
      {
        id: 'embed',
        kind: 'kb.ingest.embed',
        input: { sourceIds: '$.sourceIds' },
        retry: { attempts: 2, backoffMs: [250, 1000] },
      },
      {
        id: 'index',
        kind: 'kb.ingest.index',
        input: { sourceIds: '$.sourceIds' },
      },
    ],
  });
}

async function markItemFailed(
  stage: StageHandlerContext,
  sourceId: string,
  message: string,
): Promise<void> {
  await stage.database.query(
    `INSERT INTO kb_ingest_items
       (id, run_id, source_id, document_id, position, status, error)
     SELECT $1, $2, $3, d.id, 0, 'failed', $4
       FROM kb_documents d WHERE d.source_id = $3
     ON CONFLICT (run_id, source_id) DO UPDATE
       SET status = 'failed', error = EXCLUDED.error, updated_at = now()`,
    [ulid(), stage.runId, sourceId, message.slice(0, 500)],
  );
  await stage.database.query(
    `UPDATE kb_sources SET status = 'failed', updated_at = now() WHERE id = $1`,
    [sourceId],
  );
}
