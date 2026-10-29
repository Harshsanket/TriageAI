/**
 * Knowledge-base module public DTOs (Phase 4; moved from the module in Phase
 * 10B so the web host, the setup wizard and `public-api` share one shape).
 */
import { z } from 'zod';

export const KbDocumentDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  approved: z.boolean(),
  version: z.number().int(),
  sha256: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KbDocumentDto = z.infer<typeof KbDocumentDtoSchema>;

export const KbDocumentCreateRequestSchema = z.object({
  title: z.string().min(1).max(300),
  body: z.string().min(1).max(200_000),
  source: z.string().min(1).max(300).default('manual'),
});
export type KbDocumentCreateRequest = z.input<typeof KbDocumentCreateRequestSchema>;

export const KbIngestResultSchema = z.object({
  changed: z.boolean(),
  version: z.number().int(),
  chunks: z.number().int().nonnegative(),
});
export type KbIngestResult = z.infer<typeof KbIngestResultSchema>;

/** Create / approve / re-ingest all answer with the document and what ingestion did. */
export const KbDocumentWriteResponseSchema = z.object({
  document: KbDocumentDtoSchema,
  ingest: KbIngestResultSchema,
});
export type KbDocumentWriteResponse = z.infer<typeof KbDocumentWriteResponseSchema>;

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
  metadata: z.record(z.unknown()),
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
