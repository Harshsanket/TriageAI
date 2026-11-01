/**
 * Structured extraction DTOs (Phase 20.3). Documents become typed rows owned by
 * `modules/data-extract`; numbers are answered by SQL, never by a model reading
 * raw rows (ADR-0052).
 */
import { z } from 'zod';

export const ExtractionProfileSchema = z.enum([
  'transactions',
  'generic-table',
  'invoice',
  'contacts',
]);
export type ExtractionProfile = z.infer<typeof ExtractionProfileSchema>;

export const ExtractionStatusSchema = z.enum(['ready', 'needs_review', 'failed']);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

export const ColumnMappingSchema = z.record(z.string(), z.string());
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

export const ExtractedDatasetDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  profile: ExtractionProfileSchema,
  status: ExtractionStatusSchema,
  sourceId: z.string().nullable(),
  sourceLabel: z.string(),
  rowCount: z.number().int().nonnegative(),
  pinned: z.boolean(),
  sensitivity: z.enum(['public', 'internal', 'restricted', 'secret']),
  mapping: ColumnMappingSchema,
  reviewReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExtractedDatasetDto = z.infer<typeof ExtractedDatasetDtoSchema>;

export const ExtractedRowDtoSchema = z.object({
  id: z.string(),
  datasetId: z.string(),
  fields: z.record(z.unknown()),
  category: z.string().nullable(),
  categorySource: z.enum(['rule', 'suggested', 'user']).nullable(),
  createdAt: z.string(),
});
export type ExtractedRowDto = z.infer<typeof ExtractedRowDtoSchema>;

export const ImportDatasetRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    /** CSV or XLSX content; text formats are decoded by the module. */
    content: z.string().min(1).max(5_000_000),
    mediaType: z
      .enum([
        'text/csv',
        'text/plain',
        'text/tab-separated-values',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/pdf',
      ])
      .default('text/csv'),
    contentEncoding: z.enum(['text', 'base64']).default('text'),
    sourceId: z.string().max(200).optional(),
    sourceLabel: z.string().max(200).default('upload'),
    profile: ExtractionProfileSchema.optional(),
    mapping: ColumnMappingSchema.optional(),
    confirmMapping: z.boolean().default(false),
    account: z.string().max(120).optional(),
    openingBalance: z.number().optional(),
    closingBalance: z.number().optional(),
    pinned: z.boolean().default(false),
  })
  .strict();
export type ImportDatasetRequest = z.input<typeof ImportDatasetRequestSchema>;

export const ImportDatasetResponseSchema = z.object({
  dataset: ExtractedDatasetDtoSchema,
  mapping: ColumnMappingSchema,
  needsMappingConfirmation: z.boolean(),
  inserted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
});
export type ImportDatasetResponse = z.infer<typeof ImportDatasetResponseSchema>;

export const DatasetSummarySchema = z.object({
  dataset: ExtractedDatasetDtoSchema,
  totals: z.object({
    in: z.number(),
    out: z.number(),
    net: z.number(),
    rows: z.number().int().nonnegative(),
  }),
  byCategory: z.array(
    z.object({ category: z.string(), total: z.number(), count: z.number().int() }),
  ),
  byMonth: z.array(z.object({ month: z.string(), total: z.number(), count: z.number().int() })),
  topMerchants: z.array(
    z.object({ merchant: z.string(), total: z.number(), count: z.number().int() }),
  ),
  recurring: z.array(
    z.object({ description: z.string(), amount: z.number(), occurrences: z.number().int() }),
  ),
});
export type DatasetSummary = z.infer<typeof DatasetSummarySchema>;

export const DatasetQuerySchema = z
  .object({
    datasetId: z.string().min(1),
    from: z.string().optional(),
    to: z.string().optional(),
    category: z.string().max(120).optional(),
    merchantContains: z.string().max(120).optional(),
    direction: z.enum(['in', 'out']).optional(),
    aggregate: z.enum(['sum', 'count', 'rows']).default('sum'),
    limit: z.number().int().positive().max(200).default(50),
  })
  .strict();
export type DatasetQuery = z.input<typeof DatasetQuerySchema>;

export const DatasetQueryResultSchema = z.object({
  datasetId: z.string(),
  aggregate: z.enum(['sum', 'count', 'rows']),
  total: z.number().nullable(),
  rows: z.array(ExtractedRowDtoSchema),
  query: z.string(),
});
export type DatasetQueryResult = z.infer<typeof DatasetQueryResultSchema>;

export const DatasetRuleSchema = z.object({
  keyword: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(120),
});
export type DatasetRule = z.infer<typeof DatasetRuleSchema>;
