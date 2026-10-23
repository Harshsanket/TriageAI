/**
 * Shared DTO contracts between kernel/modules/hosts and the frontend.
 * Zod schemas are the single source of truth; JSON Schemas are exported
 * for the Python-side sync (see docs/contracts/module-contract.md §5).
 */
import { z } from 'zod';

export const UlidSchema = z.string().ulid();

// ── Module manifest (ADR-0007) ────────────────────────────────────────────────

export const ModuleUiRouteSchema = z.object({
  path: z.string().startsWith('/'),
  title: z.string().optional(),
});
export type ModuleUiRoute = z.infer<typeof ModuleUiRouteSchema>;

export const ModuleNavEntrySchema = z.object({
  label: z.string(),
  icon: z.string().optional(),
  order: z.number().int(),
  path: z.string().startsWith('/'),
});
export type ModuleNavEntry = z.infer<typeof ModuleNavEntrySchema>;

export const ModuleBackgroundPollerSchema = z.object({
  query: z.string(),
  intervalMs: z.number().int().positive(),
});
export type ModuleBackgroundPoller = z.infer<typeof ModuleBackgroundPollerSchema>;

export const ModuleManifestSchema = z.object({
  routes: z.array(ModuleUiRouteSchema).default([]),
  nav: z.array(ModuleNavEntrySchema).default([]),
  background: z.array(ModuleBackgroundPollerSchema).default([]),
});
export type ModuleManifest = z.infer<typeof ModuleManifestSchema>;

export const ManifestModuleSchema = z.object({
  id: z.string(),
  version: z.string(),
  manifest: ModuleManifestSchema,
});
export type ManifestModule = z.infer<typeof ManifestModuleSchema>;

export const SystemManifestSchema = z.object({
  generatedAt: z.string(),
  modules: z.array(ManifestModuleSchema),
});
export type SystemManifest = z.infer<typeof SystemManifestSchema>;

// ── Module info (admin) ───────────────────────────────────────────────────────

export const ModuleInfoSchema = z.object({
  id: z.string(),
  version: z.string(),
  status: z.literal('enabled'),
  capabilities: z.array(z.string()),
  health: z.enum(['healthy', 'degraded', 'down']).optional(),
});
export type ModuleInfo = z.infer<typeof ModuleInfoSchema>;

// ── Workflow runs (Phase 1 read model) ───────────────────────────────────────

export const StageStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
  'TIMED_OUT',
]);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const RunStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED_PENDING',
  'CANCELLED',
  'AWAITING',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StageRunDtoSchema = z.object({
  id: UlidSchema,
  runId: UlidSchema,
  stageId: z.string(),
  kind: z.string(),
  status: StageStatusSchema,
  attempts: z.number().int(),
  output: z.unknown().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type StageRunDto = z.infer<typeof StageRunDtoSchema>;

export const RunDtoSchema = z.object({
  id: UlidSchema,
  workflowId: z.string(),
  workflowVersion: z.string(),
  trigger: z.string(),
  status: RunStatusSchema,
  input: z.unknown().nullable(),
  output: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunDto = z.infer<typeof RunDtoSchema>;

export const DecisionRecordDtoSchema = z.object({
  id: UlidSchema,
  runId: UlidSchema,
  stageRunId: UlidSchema,
  workflowId: z.string(),
  moduleId: z.string(),
  moduleVersion: z.string(),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  deterministic: z.record(z.string(), z.unknown()).nullable(),
  timings: z.record(z.string(), z.unknown()).nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type DecisionRecordDto = z.infer<typeof DecisionRecordDtoSchema>;

// ── Health ────────────────────────────────────────────────────────────────────

export const HealthReportSchema = z.enum(['healthy', 'degraded', 'down']);
export type HealthReport = z.infer<typeof HealthReportSchema>;
