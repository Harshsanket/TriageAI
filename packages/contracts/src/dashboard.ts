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

// ── Phase 18.T24: trajectory quality and step scores ────────────────────────

export const TrajectoryStepScoreSchema = z.object({
  nodeId: z.string(),
  score: z.number().min(0).max(1),
  passed: z.boolean(),
  evaluator: z.string(),
  findings: z.array(z.string()).default([]),
});
export type TrajectoryStepScore = z.infer<typeof TrajectoryStepScoreSchema>;

export const TrajectoryMetricsSchema = z.object({
  runId: z.string(),
  steps: z.number().int().nonnegative(),
  redundantSteps: z.number().int().nonnegative(),
  wastedSteps: z.number().int().nonnegative(),
  /**
   * Reference steps ÷ steps taken. Uses a golden reference when one exists,
   * otherwise the deduplicated taken path; null only for legacy rows.
   */
  pathEfficiency: z.number().nonnegative().nullable(),
  firstFailingNode: z.string().nullable(),
  scores: z.array(TrajectoryStepScoreSchema).default([]),
  createdAt: z.string(),
});
export type TrajectoryMetricsDto = z.infer<typeof TrajectoryMetricsSchema>;

export const DashboardTrajectorySchema = z.object({
  runs: z.number().int().nonnegative(),
  averagePathEfficiency: z.number().nonnegative().nullable(),
  stepPassRate: z.number().min(0).max(1).nullable(),
  wastedSteps: z.number().int().nonnegative(),
  redundantSteps: z.number().int().nonnegative(),
  mostCommonFailingStep: z.string().nullable(),
});
export type DashboardTrajectory = z.infer<typeof DashboardTrajectorySchema>;

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

export const DashboardAgentWatchdogSchema = z.object({
  paused: z.boolean().default(false),
  recentFailures: z.number().int().nonnegative().default(0),
  /** `repeated_failures` is emitted only when the persisted steps show them. */
  flag: z.enum(['paused', 'repeated_failures']).nullable().default(null),
});
export type DashboardAgentWatchdog = z.infer<typeof DashboardAgentWatchdogSchema>;

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
  /** Latest persisted checkpoint state (19.T5 full agents tile), when present. */
  status: z.enum(['idle', 'running', 'awaiting_human', 'paused', 'done', 'failed']).optional(),
  currentStep: z.number().int().nonnegative().nullable().optional(),
  stepLimit: z.number().int().positive().nullable().optional(),
  contextPercent: z.number().min(0).max(100).nullable().optional(),
  contextUsedTokens: z.number().int().nonnegative().nullable().optional(),
  contextLimitTokens: z.number().int().positive().nullable().optional(),
  watchdog: DashboardAgentWatchdogSchema.optional(),
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

// ── Phase 19.T5/19.T6: the remaining §19.4 tiles and exact metrics ──────────

export const DashboardAlertSchema = z.object({
  id: z.string(),
  severity: z.enum(['warning', 'critical']),
  message: z.string(),
  value: z.union([z.number(), z.boolean()]),
  threshold: z.number(),
});
export type DashboardAlert = z.infer<typeof DashboardAlertSchema>;

/** Valid-schema rate from `model_call_traces.trace.schemaValidFirstTry`. */
export const DashboardSchemaValiditySchema = z.object({
  available: z.boolean().default(false),
  calls: z.number().int().nonnegative().default(0),
  validFirstTry: z.number().int().nonnegative().default(0),
  rate: z.number().min(0).max(1).nullable().default(null),
});
export type DashboardSchemaValidity = z.infer<typeof DashboardSchemaValiditySchema>;

/** Tool-call outcomes from `model_call_traces.trace.toolCalls` statuses. */
export const DashboardToolCallsSchema = z.object({
  available: z.boolean().default(false),
  calls: z.number().int().nonnegative().default(0),
  ok: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  blocked: z.number().int().nonnegative().default(0),
  successRate: z.number().min(0).max(1).nullable().default(null),
});
export type DashboardToolCalls = z.infer<typeof DashboardToolCallsSchema>;

/** Retrievals with at least one selected chunk that a later answer cited. */
export const DashboardRetrievalSchema = z.object({
  available: z.boolean().default(false),
  retrievals: z.number().int().nonnegative().default(0),
  hits: z.number().int().nonnegative().default(0),
  hitRate: z.number().min(0).max(1).nullable().default(null),
});
export type DashboardRetrieval = z.infer<typeof DashboardRetrievalSchema>;

export const DashboardTaskCompletionSchema = z.object({
  windowDays: z.number().int().positive().default(7),
  started: z.number().int().nonnegative().default(0),
  succeeded: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
  cancelled: z.number().int().nonnegative().default(0),
  awaiting: z.number().int().nonnegative().default(0),
  active: z.number().int().nonnegative().default(0),
  rate: z.number().min(0).max(1).nullable().default(null),
});
export type DashboardTaskCompletion = z.infer<typeof DashboardTaskCompletionSchema>;

/** Cost per token / per executed step / per completed run (19.3/19.T6). */
export const DashboardUnitCostsSchema = z.object({
  windowDays: z.number().int().positive().default(7),
  costUsd: z.number().nonnegative().default(0),
  tokens: z.number().int().nonnegative().default(0),
  steps: z.number().int().nonnegative().default(0),
  completedRuns: z.number().int().nonnegative().default(0),
  costPerTokenUsd: z.number().nonnegative().nullable().default(null),
  costPerStepUsd: z.number().nonnegative().nullable().default(null),
  costPerCompletedRunUsd: z.number().nonnegative().nullable().default(null),
});
export type DashboardUnitCosts = z.infer<typeof DashboardUnitCostsSchema>;

export const DashboardWakeUpPointSchema = z.object({
  date: z.string(),
  total: z.number().int().nonnegative().default(0),
  byTrigger: z.record(z.string(), z.number().int().nonnegative()).default({}),
});
export type DashboardWakeUpPoint = z.infer<typeof DashboardWakeUpPointSchema>;

/** Largest context part behind a run (from `agent_steps.payload.context`). */
export const DashboardContextPartSchema = z.object({
  source: z.string(),
  tokens: z.number().int().nonnegative(),
});

export const DashboardWakeUpRunSchema = z.object({
  runId: z.string(),
  workflowId: z.string(),
  tokensIn: z.number().int().nonnegative().default(0),
  tokensCached: z.number().int().nonnegative().default(0),
  tokensOut: z.number().int().nonnegative().default(0),
  /** (tokensIn + tokensCached) ÷ tokensOut. */
  reReadRatio: z.number().nonnegative().nullable().default(null),
  costUsd: z.number().nonnegative().default(0),
  contextParts: z.array(DashboardContextPartSchema).default([]),
});
export type DashboardWakeUpRun = z.infer<typeof DashboardWakeUpRunSchema>;

export const DashboardWakeUpsSchema = z.object({
  windowDays: z.number().int().positive().default(7),
  points: z.array(DashboardWakeUpPointSchema).default([]),
  total: z.number().int().nonnegative().default(0),
  /** Schedule runs that ended `no_change` (probes) in the window. */
  probes: z.number().int().nonnegative().default(0),
  averageReReadRatio: z.number().nonnegative().nullable().default(null),
  reReadThreshold: z.number().positive().default(50),
  runsAboveThreshold: z.number().int().nonnegative().default(0),
  alert: z.boolean().default(false),
  topRuns: z.array(DashboardWakeUpRunSchema).default([]),
});
export type DashboardWakeUps = z.infer<typeof DashboardWakeUpsSchema>;

export const DashboardRoutingModelSchema = z.object({
  provider: z.string(),
  model: z.string(),
  /** From `capabilities.runtimes[].tier`; `unclassified` when absent. */
  tier: z.string().default('unclassified'),
  calls: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
});
export type DashboardRoutingModel = z.infer<typeof DashboardRoutingModelSchema>;

export const DashboardRoutingSchema = z.object({
  windowDays: z.number().int().positive().default(7),
  calls: z.number().int().nonnegative().default(0),
  byModel: z.array(DashboardRoutingModelSchema).default([]),
  byTier: z.record(z.string(), z.number().int().nonnegative()).default({}),
  byReason: z
    .array(z.object({ reason: z.string(), calls: z.number().int().nonnegative() }))
    .default([]),
  escalations: z.number().int().nonnegative().default(0),
  fallbacks: z.number().int().nonnegative().default(0),
  repairs: z.number().int().nonnegative().default(0),
});
export type DashboardRouting = z.infer<typeof DashboardRoutingSchema>;

/** Cache use from existing counters only (no new instrumentation). */
export const DashboardCachesSchema = z.object({
  windowDays: z.number().int().positive().default(7),
  /** `ai.generate` decision records that report `cacheHit`. */
  generation: z
    .object({
      available: z.boolean().default(false),
      lookups: z.number().int().nonnegative().default(0),
      hits: z.number().int().nonnegative().default(0),
      hitRate: z.number().min(0).max(1).nullable().default(null),
    })
    .default({ available: false, lookups: 0, hits: 0, hitRate: null }),
  /** Provider prompt caching, reported by the ledger's `tokens_cached`. */
  prompt: z
    .object({
      tokensCached: z.number().int().nonnegative().default(0),
      tokensIn: z.number().int().nonnegative().default(0),
      hitRate: z.number().min(0).max(1).nullable().default(null),
      savedUsd: z.number().nonnegative().nullable().default(null),
      priced: z.boolean().default(false),
    })
    .default({
      tokensCached: 0,
      tokensIn: 0,
      hitRate: null,
      savedUsd: null,
      priced: false,
    }),
  /** Retrieval caching has no persisted hit flag; never guessed here. */
  retrieval: z.object({ available: z.boolean().default(false) }).default({ available: false }),
});
export type DashboardCaches = z.infer<typeof DashboardCachesSchema>;

/** Context packs built by the agent runtime and context budgeting on calls. */
export const DashboardContextPacksSchema = z.object({
  available: z.boolean().default(false),
  totalContexts: z.number().int().nonnegative().default(0),
  callsMeasured: z.number().int().nonnegative().default(0),
  contextLimit: z.number().int().positive().nullable().default(null),
  averageUsedTokens: z.number().nonnegative().nullable().default(null),
  p95UsedTokens: z.number().nonnegative().nullable().default(null),
  averagePercent: z.number().min(0).max(100).nullable().default(null),
  p95Percent: z.number().min(0).max(100).nullable().default(null),
});
export type DashboardContextPacks = z.infer<typeof DashboardContextPacksSchema>;

export const DashboardRoutineScheduleSchema = z.object({
  scheduleId: z.string(),
  workflowId: z.string(),
  runs: z.number().int().nonnegative().default(0),
  noChange: z.number().int().nonnegative().default(0),
  useful: z.number().int().nonnegative().default(0),
  usefulRunRate: z.number().min(0).max(1).nullable().default(null),
  costUsd: z.number().nonnegative().default(0),
  costPerUsefulRun: z.number().nonnegative().nullable().default(null),
  suggestion: z.enum(['keep', 'slow_down', 'event_trigger', 'add_probe', 'retire']).default('keep'),
});
export type DashboardRoutineSchedule = z.infer<typeof DashboardRoutineScheduleSchema>;

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
  /** User-flagged runs in the last 24 h over total runs (19.T6). */
  flags: z
    .object({ total: z.number(), runs: z.number(), rate: z.number() })
    .default({ total: 0, runs: 0, rate: 0 }),
  /** Team coordination overhead (19.T4); unavailable without classified tasks. */
  coordination: z
    .object({
      available: z.boolean(),
      overhead: z.number().optional(),
      threshold: z.number(),
      alert: z.boolean().optional(),
    })
    .default({ available: false, threshold: 0.3 }),
  /** Stable-path pipeline suggestions from run history (18.T23). */
  suggestions: z
    .array(
      z.object({
        workflowId: z.string(),
        runs: z.number().int().nonnegative(),
        share: z.number().min(0).max(1),
        path: z.array(z.string()),
        suggest: z.boolean(),
      }),
    )
    .default([]),
  /** Chat context usage (19.T5); null when the chat module is disabled. */
  context: z
    .object({
      conversations: z.number().int().nonnegative(),
      averagePercent: z.number().nullable(),
      compacted: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  /** Scheduled routines (19.T5/19.T8). */
  routines: z
    .object({
      schedules: z.number().int().nonnegative(),
      noChange: z.number().int().nonnegative(),
      skippedOverlap: z.number().int().nonnegative(),
      windowDays: z.number().int().positive().default(7),
      scheduledRuns: z.number().int().nonnegative().default(0),
      usefulRuns: z.number().int().nonnegative().default(0),
      usefulRunRate: z.number().min(0).max(1).nullable().default(null),
      costUsd: z.number().nonnegative().default(0),
      costPerUsefulRun: z.number().nonnegative().nullable().default(null),
      noChangeShare: z.number().min(0).max(1).nullable().default(null),
      bySchedule: z.array(DashboardRoutineScheduleSchema).default([]),
    })
    .default({
      schedules: 0,
      noChange: 0,
      skippedOverlap: 0,
      windowDays: 7,
      scheduledRuns: 0,
      usefulRuns: 0,
      usefulRunRate: null,
      costUsd: 0,
      costPerUsefulRun: null,
      noChangeShare: null,
      bySchedule: [],
    }),
  /** Online eval quality (19.T5/19.T6). */
  quality: z
    .object({
      reports: z.number().int().nonnegative(),
      passes: z.number().int().nonnegative(),
      passRate: z.number().nullable(),
      drift: z.boolean().nullable(),
      /** Answer-stage decisions that returned the refusal text. */
      refusalRate: z.number().min(0).max(1).nullable().default(null),
      /** Auto-replies escalated to a human ÷ auto-reply attempts. */
      escalationRate: z.number().min(0).max(1).nullable().default(null),
      /** Resolved tickets with a sent/confirmed auto-reply ÷ auto-replied tickets. */
      autoResolveRate: z.number().min(0).max(1).nullable().default(null),
    })
    .default({
      reports: 0,
      passes: 0,
      passRate: null,
      drift: null,
      refusalRate: null,
      escalationRate: null,
      autoResolveRate: null,
    }),
  /** Latest admin/security audit actions (19.T5). */
  audit: z
    .object({
      lastDay: z.number().int().nonnegative(),
      recent: z.array(
        z.object({
          action: z.string(),
          actor: z.string().nullable(),
          at: z.string(),
        }),
      ),
    })
    .default({ lastDay: 0, recent: [] }),
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
  /** Latest deterministic alerts (same rules as `/system/alerts`). */
  alerts: z.array(DashboardAlertSchema).default([]),
  schemaValidity: DashboardSchemaValiditySchema.default({
    available: false,
    calls: 0,
    validFirstTry: 0,
    rate: null,
  }),
  toolCalls: DashboardToolCallsSchema.default({
    available: false,
    calls: 0,
    ok: 0,
    failed: 0,
    blocked: 0,
    successRate: null,
  }),
  retrieval: DashboardRetrievalSchema.default({
    available: false,
    retrievals: 0,
    hits: 0,
    hitRate: null,
  }),
  taskCompletion: DashboardTaskCompletionSchema.default({
    windowDays: 7,
    started: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    awaiting: 0,
    active: 0,
    rate: null,
  }),
  unitCosts: DashboardUnitCostsSchema.default({
    windowDays: 7,
    costUsd: 0,
    tokens: 0,
    steps: 0,
    completedRuns: 0,
    costPerTokenUsd: null,
    costPerStepUsd: null,
    costPerCompletedRunUsd: null,
  }),
  wakeUps: DashboardWakeUpsSchema.default({
    windowDays: 7,
    points: [],
    total: 0,
    probes: 0,
    averageReReadRatio: null,
    reReadThreshold: 50,
    runsAboveThreshold: 0,
    alert: false,
    topRuns: [],
  }),
  routing: DashboardRoutingSchema.default({
    windowDays: 7,
    calls: 0,
    byModel: [],
    byTier: {},
    byReason: [],
    escalations: 0,
    fallbacks: 0,
    repairs: 0,
  }),
  caches: DashboardCachesSchema.default({
    windowDays: 7,
    generation: { available: false, lookups: 0, hits: 0, hitRate: null },
    prompt: { tokensCached: 0, tokensIn: 0, hitRate: null, savedUsd: null, priced: false },
    retrieval: { available: false },
  }),
  contextPacks: DashboardContextPacksSchema.default({
    available: false,
    totalContexts: 0,
    callsMeasured: 0,
    contextLimit: null,
    averageUsedTokens: null,
    p95UsedTokens: null,
    averagePercent: null,
    p95Percent: null,
  }),
  /** Per-process stats for this endpoint's 5 s aggregate cache (`?fresh=1` bypasses). */
  responseCache: z
    .object({
      hit: z.boolean().default(false),
      ageMs: z.number().int().nonnegative().default(0),
      hits: z.number().int().nonnegative().default(0),
      misses: z.number().int().nonnegative().default(0),
      hitRate: z.number().min(0).max(1).default(0),
    })
    .default({ hit: false, ageMs: 0, hits: 0, misses: 0, hitRate: 0 }),
  trajectory: DashboardTrajectorySchema.default({
    runs: 0,
    averagePathEfficiency: null,
    stepPassRate: null,
    wastedSteps: 0,
    redundantSteps: 0,
    mostCommonFailingStep: null,
  }),
});
export type SystemDashboard = z.infer<typeof SystemDashboardSchema>;
