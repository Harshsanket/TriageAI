/**
 * Feedback loop public DTOs (Phase 6): candidate examples → approval →
 * versioned datasets → eval reports → model registry promotion/rollback.
 *
 * Kept in contracts so the wire shape is shared by API, web, and eval tooling.
 */
import { z } from 'zod';

export const CandidateStatusSchema = z.enum(['proposed', 'approved', 'rejected']);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

/**
 * Why the human intervened. `mistake` = the model was wrong, `better_answer` =
 * a preferable answer exists, `denied_outcome` = the outcome must not happen.
 */
export const ReviewMethodSchema = z.enum(['mistake', 'better_answer', 'denied_outcome']);
export type ReviewMethod = z.infer<typeof ReviewMethodSchema>;

export const CandidateDtoSchema = z.object({
  id: z.string(),
  source: z.string(),
  sourceRunId: z.string().nullable(),
  input: z.unknown(),
  gold: z.unknown(),
  provenance: z.record(z.unknown()),
  status: CandidateStatusSchema,
  actor: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CandidateDto = z.infer<typeof CandidateDtoSchema>;

export const CandidateReviewRequestSchema = z
  .object({
    status: z.enum(['approved', 'rejected']),
    actor: z.string().min(1).max(200).default('admin'),
    method: ReviewMethodSchema.optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

/**
 * Per-category correction export (Phase 7). CI blesses these as fixture sets;
 * only reviewed examples leave the review queue.
 */
export const CandidateExportExampleSchema = z.object({
  id: z.string(),
  text: z.string(),
  expected: z.string(),
  input: z.unknown(),
  gold: z.unknown(),
  provenance: z.record(z.unknown()),
});
export type CandidateExportExample = z.infer<typeof CandidateExportExampleSchema>;

export const CandidateExportDtoSchema = z.object({
  category: z.string().nullable(),
  status: CandidateStatusSchema,
  count: z.number().int().nonnegative(),
  examples: z.array(CandidateExportExampleSchema),
});
export type CandidateExportDto = z.infer<typeof CandidateExportDtoSchema>;

export const CorrectionRequestSchema = z
  .object({
    runId: z.string().optional(),
    stageRunId: z.string().optional(),
    input: z.unknown(),
    gold: z.unknown(),
    reason: z.string().max(2000).optional(),
    actor: z.string().max(200).optional(),
    method: ReviewMethodSchema.default('mistake'),
  })
  .strict();

export const DatasetSplitNameSchema = z.enum(['train', 'val', 'test']);
export type DatasetSplitName = z.infer<typeof DatasetSplitNameSchema>;

export const DatasetRatiosSchema = z
  .object({
    train: z.number().positive().max(0.95).default(0.7),
    val: z.number().positive().max(0.5).default(0.15),
    test: z.number().positive().max(0.5).default(0.15),
  })
  .strict();

export const DatasetSplitCountsSchema = z.object({
  train: z.number().int().nonnegative(),
  val: z.number().int().nonnegative(),
  test: z.number().int().nonnegative(),
});
export type DatasetSplitCounts = z.infer<typeof DatasetSplitCountsSchema>;

export const DatasetDtoSchema = z.object({
  id: z.string(),
  version: z.string(),
  purpose: z.string(),
  sha256: z.string(),
  splits: z.object({
    train: z.array(z.string()),
    val: z.array(z.string()),
    test: z.array(z.string()),
  }),
  counts: DatasetSplitCountsSchema,
  classBalance: z.record(DatasetSplitCountsSchema).default({}),
  strategy: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export type DatasetDto = z.infer<typeof DatasetDtoSchema>;

export const DatasetBuildRequestSchema = z
  .object({
    purpose: z.string().min(1).max(100).default('classifier'),
    ratios: DatasetRatiosSchema.optional(),
    createdBy: z.string().min(1).max(200).default('admin'),
  })
  .strict();

export const DatasetExampleExportSchema = z.object({
  id: z.string(),
  split: DatasetSplitNameSchema,
  input: z.unknown(),
  gold: z.unknown(),
  provenance: z.record(z.unknown()),
});
export type DatasetExampleExport = z.infer<typeof DatasetExampleExportSchema>;

export const DatasetExportDtoSchema = z.object({
  datasetId: z.string(),
  version: z.string(),
  purpose: z.string(),
  sha256: z.string(),
  examples: z.array(DatasetExampleExportSchema),
});
export type DatasetExportDto = z.infer<typeof DatasetExportDtoSchema>;

export const ModelComponentSchema = z.enum(['embedder', 'classifier', 'generator', 'retriever']);
export type ModelComponent = z.infer<typeof ModelComponentSchema>;

export const ModelStatusSchema = z.enum([
  'registered',
  'candidate',
  'active',
  'rolled_back',
  'retired',
]);
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

export const ModelAssetDtoSchema = z.object({
  id: z.string(),
  component: ModelComponentSchema,
  name: z.string(),
  artifactRef: z.string().nullable(),
  config: z.record(z.unknown()),
  evalReportId: z.string().nullable(),
  status: ModelStatusSchema,
  promotedAt: z.string().nullable(),
  createdAt: z.string(),
  evalReport: z.unknown().nullable().optional(),
});
export type ModelAssetDto = z.infer<typeof ModelAssetDtoSchema>;

export const RegisterModelRequestSchema = z
  .object({
    component: ModelComponentSchema,
    name: z.string().min(1).max(200),
    artifactRef: z.string().max(500).nullable().optional(),
    config: z.record(z.unknown()).default({}),
    evalReportId: z.string().nullable().optional(),
    actor: z.string().min(1).max(200).default('admin'),
  })
  .strict();

export const PromoteModelRequestSchema = z
  .object({
    actor: z.string().min(1).max(200).default('admin'),
    evalReportId: z.string().nullable().optional(),
  })
  .strict();

export const RollbackModelRequestSchema = z
  .object({
    actor: z.string().min(1).max(200).default('admin'),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export const EvalSuiteResultSchema = z.object({
  suite: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  metrics: z.record(z.number()).default({}),
  gates: z.record(z.number()).default({}),
  details: z.record(z.unknown()).optional(),
});
export type EvalSuiteResult = z.infer<typeof EvalSuiteResultSchema>;

/**
 * Canonical metric bag shared by classifier, retrieval, and generation suites.
 * Unknown numeric metrics are allowed so new suites do not break ingestion.
 */
export const EvalMetricsSchema = z
  .object({
    macroF1: z.number().nullable().optional(),
    falseAutoRoutingCount: z.number().int().nonnegative().nullable().optional(),
    p95LatencyMs: z.number().nonnegative().nullable().optional(),
    recallAt3: z.number().nullable().optional(),
    mrr: z.number().nullable().optional(),
    groundedness: z.number().nullable().optional(),
    citationCoverage: z.number().nullable().optional(),
  })
  .catchall(z.union([z.number(), z.null()]));
export type EvalMetrics = z.infer<typeof EvalMetricsSchema>;

export const EvalReportInputSchema = z.object({
  generatedAt: z.string().datetime(),
  subjectModelId: z.string().nullable().optional(),
  baselineModelId: z.string().nullable().optional(),
  suites: z.array(EvalSuiteResultSchema).min(1),
  metrics: EvalMetricsSchema,
  passes: z.boolean(),
  artifact: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type EvalReportInput = z.infer<typeof EvalReportInputSchema>;

export const EvalReportDtoSchema = z.object({
  id: z.string(),
  generatedAt: z.string(),
  subjectModelId: z.string().nullable(),
  baselineModelId: z.string().nullable(),
  suites: z.array(EvalSuiteResultSchema),
  metrics: EvalMetricsSchema,
  passes: z.boolean(),
  artifact: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type EvalReportDto = z.infer<typeof EvalReportDtoSchema>;
