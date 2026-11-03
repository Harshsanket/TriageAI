/**
 * `/dashboard` v1 read model (Phase 19.4). Aggregated from existing kernel,
 * run, queue, knowledge and identity tables; no new instrumentation.
 */
import { z } from 'zod';

import { RunStatusSchema } from './manifest.js';

export const DashboardHealthStatusSchema = z.enum(['healthy', 'degraded', 'down']);
export type DashboardHealthStatus = z.infer<typeof DashboardHealthStatusSchema>;

export const DashboardModuleHealthSchema = z.object({
  id: z.string(),
  version: z.string(),
  health: DashboardHealthStatusSchema,
});
export type DashboardModuleHealth = z.infer<typeof DashboardModuleHealthSchema>;

export const DashboardCapabilitySchema = z.object({
  id: z.string(),
  adapter: z.string(),
});
export type DashboardCapability = z.infer<typeof DashboardCapabilitySchema>;

export const DashboardQueueSchema = z.object({
  pending: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  deadLetters: z.number().int().nonnegative(),
});
export type DashboardQueue = z.infer<typeof DashboardQueueSchema>;

export const DashboardHealthSchema = z.object({
  status: DashboardHealthStatusSchema,
  database: z.enum(['up', 'down']),
  modules: z.array(DashboardModuleHealthSchema),
  capabilities: z.array(DashboardCapabilitySchema),
  queue: DashboardQueueSchema,
});
export type DashboardHealth = z.infer<typeof DashboardHealthSchema>;

export const DashboardRunSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  status: RunStatusSchema,
  createdAt: z.string(),
});
export type DashboardRun = z.infer<typeof DashboardRunSchema>;

export const DashboardActivitySchema = z.object({
  runsLastHour: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(),
  recentRuns: z.array(DashboardRunSchema),
});
export type DashboardActivity = z.infer<typeof DashboardActivitySchema>;

export const DashboardKnowledgeSchema = z.object({
  documents: z.number().int().nonnegative(),
  pendingApproval: z.number().int().nonnegative(),
});
export type DashboardKnowledge = z.infer<typeof DashboardKnowledgeSchema>;

export const DashboardUsersByRoleSchema = z.object({
  customer: z.number().int().nonnegative(),
  agent: z.number().int().nonnegative(),
  admin: z.number().int().nonnegative(),
});
export type DashboardUsersByRole = z.infer<typeof DashboardUsersByRoleSchema>;

export const DashboardSecuritySchema = z.object({
  authMode: z.enum(['disabled', 'required']),
  usersByRole: DashboardUsersByRoleSchema,
  auditEventsLastDay: z.number().int().nonnegative(),
});
export type DashboardSecurity = z.infer<typeof DashboardSecuritySchema>;

export const DashboardCostSchema = z.object({
  todayUsd: z.number().nonnegative(),
  monthToDateUsd: z.number().nonnegative(),
  tokensToday: z.number().int().nonnegative(),
  callsToday: z.number().int().nonnegative(),
});
export type DashboardCost = z.infer<typeof DashboardCostSchema>;

export const DashboardEfficiencySchema = z.object({
  avgLatencyMs: z.number().nonnegative().nullable(),
  p95LatencyMs: z.number().nonnegative().nullable(),
  modelCallsToday: z.number().int().nonnegative(),
});
export type DashboardEfficiency = z.infer<typeof DashboardEfficiencySchema>;

export const DashboardModelCallsSchema = z.object({
  today: z.number().int().nonnegative(),
  byProvider: z.array(z.object({ provider: z.string(), calls: z.number().int().nonnegative() })),
});
export type DashboardModelCalls = z.infer<typeof DashboardModelCallsSchema>;

export const DashboardUsagePointSchema = z.object({
  bucket: z.string(),
  runs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  chatMessages: z.number().int().nonnegative(),
  tickets: z.number().int().nonnegative(),
  byModule: z.record(z.string(), z.number().int().nonnegative()).prefault({}),
});
export type DashboardUsagePoint = z.infer<typeof DashboardUsagePointSchema>;

export const DashboardUsageSchema = z.object({
  window: z.enum(['hour', 'day', 'week']),
  points: z.array(DashboardUsagePointSchema),
});
export type DashboardUsage = z.infer<typeof DashboardUsageSchema>;

export const DashboardAgentSeriesPointSchema = z.object({
  bucket: z.string(),
  runs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
});

export const DashboardAgentSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  color: z.string(),
  running: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  series: z.array(DashboardAgentSeriesPointSchema),
});
export type DashboardAgent = z.infer<typeof DashboardAgentSchema>;

export const DashboardKnowledgeGrowthSchema = z.object({
  points: z.array(
    z.object({
      bucket: z.string(),
      sources: z.number().int().nonnegative(),
      documents: z.number().int().nonnegative(),
      chunks: z.number().int().nonnegative(),
      datasets: z.number().int().nonnegative(),
    }),
  ),
  ingestJobs: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
});
export type DashboardKnowledgeGrowth = z.infer<typeof DashboardKnowledgeGrowthSchema>;

export const DashboardPinnedDatasetSchema = z.object({
  id: z.string(),
  title: z.string(),
  profile: z.string(),
  rowCount: z.number().int().nonnegative(),
  total: z.number().nullable(),
});
export type DashboardPinnedDataset = z.infer<typeof DashboardPinnedDatasetSchema>;

// ── Phase 23.1/23.2: usage windows, uptime, storage ─────────────────────────

export const DashboardUsageWindowSchema = z.enum(['day', 'month', 'year', 'custom']);
export type DashboardUsageWindow = z.infer<typeof DashboardUsageWindowSchema>;

export const DashboardModelUsageSchema = z.object({
  window: DashboardUsageWindowSchema,
  from: z.string(),
  to: z.string(),
  totals: z.object({
    tokensIn: z.number().int().nonnegative(),
    tokensOut: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    fallbacks: z.number().int().nonnegative(),
    timeouts: z.number().int().nonnegative(),
  }),
  /** Buckets per model; the UI stacks by model/agent/module from these rows. */
  points: z.array(
    z.object({
      bucket: z.string(),
      byModel: z.record(
        z.string(),
        z.object({
          tokensIn: z.number().int().nonnegative(),
          tokensOut: z.number().int().nonnegative(),
        }),
      ),
      byAgent: z.record(z.string(), z.number().int().nonnegative()).prefault({}),
      byModule: z.record(z.string(), z.number().int().nonnegative()).prefault({}),
    }),
  ),
  byModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      calls: z.number().int().nonnegative(),
      tokensIn: z.number().int().nonnegative(),
      tokensOut: z.number().int().nonnegative(),
      ttftMeanMs: z.number().nonnegative().nullable(),
      ttftP95Ms: z.number().nonnegative().nullable(),
      tokensPerSecondMean: z.number().nonnegative().nullable(),
      tokensPerSecondP95: z.number().nonnegative().nullable(),
      generationMeanMs: z.number().nonnegative().nullable(),
      generationP95Ms: z.number().nonnegative().nullable(),
    }),
  ),
});
export type DashboardModelUsage = z.infer<typeof DashboardModelUsageSchema>;

export const DashboardUptimeTargetSchema = z.object({
  target: z.string(),
  uptimePct: z.number().min(0).max(100),
  currentOk: z.boolean().nullable(),
  lastOutageAt: z.string().nullable(),
  probes: z.number().int().nonnegative(),
});
export type DashboardUptimeTarget = z.infer<typeof DashboardUptimeTargetSchema>;

export const DashboardUptimeSchema = z.object({
  systemUptimePct: z.number().min(0).max(100),
  apiUptimeSec: z.number().nonnegative(),
  restarts: z.number().int().nonnegative(),
  targets: z.array(DashboardUptimeTargetSchema),
});
export type DashboardUptime = z.infer<typeof DashboardUptimeSchema>;

export const DashboardStorageSchema = z.object({
  totalBytes: z.number().int().nonnegative(),
  databaseBytes: z.number().int().nonnegative(),
  blobBytes: z.number().int().nonnegative(),
  modelBytes: z.number().int().nonnegative(),
  pluginBytes: z.number().int().nonnegative(),
  logBytes: z.number().int().nonnegative(),
  byCategory: z.array(
    z.object({
      category: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});
export type DashboardStorage = z.infer<typeof DashboardStorageSchema>;

export const ModelRuntimeSchema = z.object({
  id: z.string(),
  adapter: z.string(),
  model: z.string(),
  baseUrl: z.string().nullable(),
  hosted: z.boolean(),
  contextWindow: z.number().int().positive().nullable(),
  maxOutput: z.number().int().positive().nullable(),
  features: z.array(z.string()),
  status: z.enum(['running', 'ready', 'disabled', 'unreachable']),
  enabled: z.boolean(),
  source: z.enum(['config', 'runtimes', 'module']),
  lastCheckAt: z.string().nullable(),
});
export type ModelRuntimeDto = z.infer<typeof ModelRuntimeSchema>;

export const SystemDashboardSchema = z.object({
  generatedAt: z.string(),
  health: DashboardHealthSchema,
  activity: DashboardActivitySchema,
  /** Null when the knowledge-base module is not enabled. */
  knowledge: DashboardKnowledgeSchema.nullable(),
  security: DashboardSecuritySchema,
  cost: DashboardCostSchema.default({
    todayUsd: 0,
    monthToDateUsd: 0,
    tokensToday: 0,
    callsToday: 0,
  }),
  efficiency: DashboardEfficiencySchema.default({
    avgLatencyMs: null,
    p95LatencyMs: null,
    modelCallsToday: 0,
  }),
  modelCalls: DashboardModelCallsSchema.default({ today: 0, byProvider: [] }),
  usage: DashboardUsageSchema.default({ window: 'day', points: [] }),
  agents: z.array(DashboardAgentSchema).default([]),
  knowledgeGrowth: DashboardKnowledgeGrowthSchema.nullable().default(null),
  pinnedDatasets: z.array(DashboardPinnedDatasetSchema).default([]),
  modelUsage: DashboardModelUsageSchema.nullable().default(null),
  modelRuntimes: z.array(ModelRuntimeSchema).default([]),
  llmDisabled: z.boolean().default(false),
  uptime: DashboardUptimeSchema.nullable().default(null),
  storage: DashboardStorageSchema.nullable().default(null),
});
export type SystemDashboard = z.infer<typeof SystemDashboardSchema>;
