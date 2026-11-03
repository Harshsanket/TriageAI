/**
 * Knowledge-base module public DTOs (Phase 4; moved from the module in Phase
 * 10B so the web host, the setup wizard and `public-api` share one shape).
 */
import { z } from 'zod';

export const KbDocumentDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  version: z.number().int(),
  sha256: z.string().nullable(),
  sourceId: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  mediaType: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KbDocumentDto = z.infer<typeof KbDocumentDtoSchema>;

export const KbDocumentCreateRequestSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(200_000),
  source: z.string().min(1).max(300).default('manual'),
  label: z.string().min(1).max(120).optional(),
  mediaType: z.string().min(1).max(200).optional(),
});
export type KbDocumentCreateRequest = z.input<typeof KbDocumentCreateRequestSchema>;

export const KbIngestResultSchema = z.object({
  changed: z.boolean(),
  version: z.number().int(),
  chunks: z.number().int().nonnegative(),
  deduped: z.boolean().default(false),
  status: z.enum(['succeeded', 'queued', 'failed']).default('succeeded'),
  failed: z.number().int().nonnegative().default(0),
});
export type KbIngestResult = z.infer<typeof KbIngestResultSchema>;

/** Create / approve / re-ingest all answer with the document and what ingestion did. */
export const KbDocumentWriteResponseSchema = z.object({
  document: KbDocumentDtoSchema,
  ingest: KbIngestResultSchema,
});
export type KbDocumentWriteResponse = z.infer<typeof KbDocumentWriteResponseSchema>;

export const KbSourceKindSchema = z.enum(['file', 'note', 'url', 'github', 'plugin']);
export type KbSourceKind = z.infer<typeof KbSourceKindSchema>;

/** Manual data-processing strategies (config → KB ingestion). */
export const KbChunkStrategySchema = z.enum([
  'structure-700',
  'structure-1200',
  'sentence-500',
  'fixed-1000',
]);
export type KbChunkStrategy = z.infer<typeof KbChunkStrategySchema>;

export const KbPdfExtractionSchema = z.enum(['text-layer', 'text-layer-strict', 'ocr']);
export type KbPdfExtraction = z.infer<typeof KbPdfExtractionSchema>;

export const KbImageExtractionSchema = z.enum(['skip', 'metadata', 'ocr']);
export type KbImageExtraction = z.infer<typeof KbImageExtractionSchema>;

export const KbDataProcessingSchema = z.object({
  chunking: KbChunkStrategySchema.default('structure-700'),
  pdfExtraction: KbPdfExtractionSchema.default('text-layer'),
  imageExtraction: KbImageExtractionSchema.default('skip'),
});
export type KbDataProcessing = z.infer<typeof KbDataProcessingSchema>;

/** Read-only storage facts shown on the KB page (Postgres, pgvector, blobs…). */
export const KbStorageBackendSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type KbStorageBackend = z.infer<typeof KbStorageBackendSchema>;

export const KbSourceStatusSchema = z.enum(['pending', 'ready', 'partial', 'failed']);
export type KbSourceStatus = z.infer<typeof KbSourceStatusSchema>;

/** Which flows may retrieve a source (ADR-0056). Missing metadata means public. */
export const KbAudienceSchema = z.enum(['public', 'operator']);
export type KbAudience = z.infer<typeof KbAudienceSchema>;

export const KbSourceDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  label: z.string(),
  uri: z.string().nullable(),
  mediaType: z.string().nullable(),
  contentHash: z.string(),
  enabled: z.boolean(),
  status: KbSourceStatusSchema,
  itemCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  sensitivity: z.enum(['public', 'internal', 'restricted', 'secret']),
  audience: KbAudienceSchema.default('public'),
  managedKey: z.string().nullable().default(null),
  readOnly: z.boolean().default(false),
  chunkPreset: z.string().default('structure-700'),
  extraction: z.string().default('text-layer'),
  storage: z.array(z.string()).default([]),
  modelUse: z.enum(['send', 'redact', 'withhold']).default('redact'),
  retentionDays: z.number().int().positive().nullable().default(null),
  lastSyncAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KbSourceDto = z.infer<typeof KbSourceDtoSchema>;

/**
 * Host-only managed-source upsert (ADR-0056/0057). The `managedKey` keeps the
 * source id and On/Off state; changed content creates a new document version.
 */
export const KbManagedSourceUpsertSchema = z
  .object({
    managedKey: z.string().min(1).max(120),
    title: z.string().trim().min(1).max(300),
    label: z.string().trim().min(1).max(120).optional(),
    body: z
      .string()
      .min(1)
      .max(20 * 1024),
    audience: KbAudienceSchema.default('operator'),
    sensitivity: z.enum(['public', 'internal', 'restricted', 'secret']).default('internal'),
    readOnly: z.boolean().default(true),
    enabled: z.boolean().optional(),
  })
  .strict();
export type KbManagedSourceUpsert = z.infer<typeof KbManagedSourceUpsertSchema>;

/** One picker feeds every source type; plugin types carry their own config. */
export const KbSourceCreateRequestSchema = z
  .object({
    kind: KbSourceKindSchema,
    title: z.string().trim().min(1).max(300),
    label: z.string().trim().min(1).max(120).optional(),
    sensitivity: z.enum(['public', 'internal', 'restricted', 'secret']).default('internal'),
    approved: z.boolean().default(false),
    // note / file text
    body: z.string().min(1).max(5_000_000).optional(),
    mediaType: z.string().min(1).max(200).optional(),
    contentBase64: z.string().max(8_000_000).optional(),
    // url / github
    url: z.string().url().optional(),
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
    ref: z.string().max(200).optional(),
    path: z.string().max(300).optional(),
    token: z.string().max(500).optional(),
    // plugin source
    type: z.string().min(1).max(60).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const KbSourceUpdateRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    label: z.string().trim().min(1).max(120).optional(),
    modelUse: z.enum(['send', 'redact', 'withhold']).optional(),
    retentionDays: z.number().int().positive().max(3650).nullable().optional(),
  })
  .strict();
export type KbSourceUpdateRequest = z.infer<typeof KbSourceUpdateRequestSchema>;

export const KbSourceListResponseSchema = z.object({
  sources: z.array(KbSourceDtoSchema),
});
export type KbSourceListResponse = z.infer<typeof KbSourceListResponseSchema>;

export const KbImportRequestSchema = z.object({
  items: z.array(KbSourceCreateRequestSchema).min(1).max(50),
  collectionTitle: z.string().trim().min(1).max(200).default('knowledge base'),
});
export type KbImportRequest = z.input<typeof KbImportRequestSchema>;

export const KbImportResponseSchema = z.object({
  sources: z.array(KbSourceDtoSchema),
  documents: z.array(KbDocumentDtoSchema),
  ingest: KbIngestResultSchema,
  jobId: z.string().nullable(),
});
export type KbImportResponse = z.infer<typeof KbImportResponseSchema>;

export const KbSearchRequestSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().positive().max(20).default(4),
});
export type KbSearchRequest = z.input<typeof KbSearchRequestSchema>;

export const KbSearchChunkSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  text: z.string(),
  score: z.number(),
  metadata: z.record(z.string(), z.unknown()),
});

export const RetrievalGateDtoSchema = z.object({
  sufficient: z.boolean(),
  topScore: z.number(),
  margin: z.number(),
  threshold: z.number(),
  marginThreshold: z.number(),
});

export const KbSearchResponseSchema = z.object({
  chunks: z.array(KbSearchChunkSchema),
  gate: RetrievalGateDtoSchema,
});
export type KbSearchResponse = z.infer<typeof KbSearchResponseSchema>;

/** Phase 23.4: KB storage total and per-source accounting. */
export const KbSourceStorageSchema = z.object({
  id: z.string(),
  title: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type KbSourceStorage = z.infer<typeof KbSourceStorageSchema>;

export const KbProcessingMetricSchema = z.object({
  label: z.string(),
  value: z.number().nonnegative(),
});
export type KbProcessingMetric = z.infer<typeof KbProcessingMetricSchema>;

export const KbProcessingStatsSchema = z.object({
  chunkStrategies: z.array(KbProcessingMetricSchema).default([]),
  ingestStatus: z.array(KbProcessingMetricSchema).default([]),
  accessModes: z.array(KbProcessingMetricSchema).default([]),
  mediaTypes: z.array(KbProcessingMetricSchema).default([]),
  contextualChunks: z.number().int().nonnegative().default(0),
  totalChunks: z.number().int().nonnegative().default(0),
  contextualRate: z.number().min(0).max(100).default(0),
  errorRate: z.number().min(0).max(100).default(0),
  pdfExtraction: z.string().default('deterministic text layer'),
});
export type KbProcessingStats = z.infer<typeof KbProcessingStatsSchema>;

export const KbStorageStatsSchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  originalsBytes: z.number().int().nonnegative(),
  textBytes: z.number().int().nonnegative(),
  chunksBytes: z.number().int().nonnegative(),
  vectorBytes: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  sources: z.array(KbSourceStorageSchema),
  backends: z.array(KbStorageBackendSchema).default([]),
  processing: KbProcessingStatsSchema.optional(),
});
export type KbStorageStats = z.infer<typeof KbStorageStatsSchema>;
