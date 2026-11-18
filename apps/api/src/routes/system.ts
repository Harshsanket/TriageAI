/** Kernel introspection + admin surface: manifest, modules, config, uninstall. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { KbDataProcessingSchema } from '@triageai/contracts';
import type { DataClass, Kernel, ModelUse, Sensitivity } from '@triageai/kernel';

import {
  ApprovalPolicySchema,
  CONTROL_CATALOG,
  DEFAULT_DATA_CLASSES,
  KERNEL_CONFIG_FIELDS,
  invalid,
} from '@triageai/kernel';

import { config } from '../platform/config.js';
import { writeAudit } from '../services/audit.js';
import { readApprovalPolicy, writeApprovalPolicy } from '../services/approvals.js';
import { readModelRuntimes } from '../services/modelRuntimes.js';
import { getControls, resolveLlmSwitch, setControls } from '../services/controls.js';
import {
  acceptScheduleSuggestion,
  listSchedules,
  readScheduleReceipt,
  SCHEDULE_SUGGESTIONS,
} from '../services/schedules.js';
import { redactValue } from '../platform/redact.js';
import type { SetupRuntime } from '../setup/boot.js';

const ControlsPatchSchema = z
  .object({
    agentsPaused: z.boolean().optional(),
    hostedModelsDisabled: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    pluginInstallsBlocked: z.boolean().optional(),
    llmDisabled: z.boolean().optional(),
    disabledRuntimes: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .strict();

const DATA_POLICY_KEY = 'dataPolicy';
const DATA_PROCESSING_KEY = 'dataProcessing';
const MODEL_USE_RANK: Record<ModelUse, number> = {
  never: 0,
  local_only: 1,
  redacted: 2,
  allowed: 3,
};
const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  restricted: 2,
  secret: 3,
};

interface DataClassOverride {
  retentionDays?: number | null;
  modelUse?: ModelUse;
  sensitivity?: Sensitivity;
  archiveBeforeDelete?: boolean;
}

interface StoredDataPolicy {
  version: number;
  overrides: Record<string, DataClassOverride>;
  presets: Record<string, Record<string, DataClassOverride>>;
  activePreset: string | null;
}

const OverrideSchema = z
  .object({
    retentionDays: z.number().int().positive().max(3650).nullable().optional(),
    modelUse: z.enum(['never', 'local_only', 'redacted', 'allowed']).optional(),
    sensitivity: z.enum(['public', 'internal', 'restricted', 'secret']).optional(),
    archiveBeforeDelete: z.boolean().optional(),
  })
  .strict();

const PolicyUpdateSchema = z
  .object({
    overrides: z.record(z.string(), OverrideSchema).optional(),
    savePreset: z.string().trim().min(1).max(40).optional(),
    applyPreset: z.string().max(40).nullable().optional(),
    reset: z.literal(true).optional(),
  })
  .strict();

const POLICY_TTL_MS = 5_000;
let policyCache: { value: StoredDataPolicy; at: number } | null = null;

async function readDataPolicy(kernel: Kernel): Promise<StoredDataPolicy> {
  // 19.T7: policy lookups are hot on every gated path; cache briefly and
  // invalidate on write. The TTL also bounds staleness across API instances.
  if (policyCache && Date.now() - policyCache.at < POLICY_TTL_MS) return policyCache.value;
  const rows = await kernel.database
    .query<{ value: StoredDataPolicy }>(`SELECT value FROM settings WHERE key = $1`, [
      DATA_POLICY_KEY,
    ])
    .catch(() => []);
  const stored = rows[0]?.value;
  const value =
    stored && typeof stored === 'object'
      ? {
          version: Number(stored.version ?? 0),
          overrides: stored.overrides ?? {},
          presets: stored.presets ?? {},
          activePreset: stored.activePreset ?? null,
        }
      : { version: 0, overrides: {}, presets: {}, activePreset: null };
  policyCache = { value, at: Date.now() };
  return value;
}

async function readDataProcessing(kernel: Kernel) {
  const rows = await kernel.database
    .query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [DATA_PROCESSING_KEY])
    .catch(() => []);
  const parsed = KbDataProcessingSchema.safeParse(rows[0]?.value ?? {});
  return parsed.success ? parsed.data : KbDataProcessingSchema.parse({});
}

function validateOverride(cls: DataClass, override: DataClassOverride): string | null {
  if (override.retentionDays != null) {
    const min = cls.bounds?.minRetentionDays ?? 1;
    const max = cls.bounds?.maxRetentionDays ?? 3650;
    if (override.retentionDays < min || override.retentionDays > max) {
      return `${cls.id}: retention must be between ${min} and ${max} days`;
    }
  }
  if (override.modelUse && cls.sensitivity === 'secret' && override.modelUse !== 'never') {
    return `${cls.id}: secret data can never reach a model`;
  }
  if (override.modelUse && cls.bounds?.strictestModelUse) {
    if (MODEL_USE_RANK[override.modelUse] > MODEL_USE_RANK[cls.bounds.strictestModelUse]) {
      return `${cls.id}: model use cannot be looser than ${cls.bounds.strictestModelUse}`;
    }
  }
  if (override.sensitivity) {
    if (SENSITIVITY_RANK[override.sensitivity] < SENSITIVITY_RANK[cls.sensitivity]) {
      return `${cls.id}: sensitivity cannot be lowered below ${cls.sensitivity}`;
    }
  }
  return null;
}

/**
 * Send-gate outcomes persisted on model traces (18.T18). The gate writes
 * `send_gate:*` security events into every trace it decides; counting them is
 * the real, persisted counter (no migration, no second source of truth).
 */
async function readSendGateStats(
  kernel: Kernel,
): Promise<{ sent: number; redacted: number; withheld: number }> {
  const rows = await kernel.database
    .query<{ sent: number; redacted: number; withheld: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE ev = 'send_gate:allowed')::int AS sent,
         COUNT(*) FILTER (WHERE ev LIKE 'send_gate:redacted:%')::int AS redacted,
         COUNT(*) FILTER (WHERE ev LIKE 'send_gate:withheld:%')::int AS withheld
       FROM model_call_traces t
       CROSS JOIN LATERAL jsonb_array_elements_text(
         COALESCE(t.trace->'securityEvents', '[]'::jsonb)
       ) AS events(ev)`,
    )
    .catch(() => []);
  return rows[0] ?? { sent: 0, redacted: 0, withheld: 0 };
}

function effectivePolicy(stored: StoredDataPolicy) {
  return Object.values(DEFAULT_DATA_CLASSES)
    .slice(0, 40)
    .map((cls) => {
      const override = stored.overrides[cls.id] ?? {};
      const retentionDays =
        override.retentionDays === undefined
          ? (cls.retention.days ?? null)
          : override.retentionDays;
      return {
        ...cls,
        effective: {
          retentionDays,
          modelUse: override.modelUse ?? cls.modelUse,
          sensitivity: override.sensitivity ?? cls.sensitivity,
          archiveBeforeDelete: override.archiveBeforeDelete ?? false,
        },
        custom: Object.keys(override).length > 0,
      };
    });
}

export function registerSystemRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  setup: SetupRuntime,
): void {
  app.get('/api/v1/system/manifest', async () => kernel.manifest());
  app.get('/api/v1/system/modules', async () => kernel.infos());
  // Read-only workflow/graph catalog for `/config` → Workflows (18.T22). The
  // graph is the declared v2 graph, or the v1 stage list compiled to one.
  app.get('/api/v1/system/workflows', async () => ({
    workflows: kernel.workflowEngine.list().map((workflow) => ({
      id: workflow.def.id,
      version: workflow.def.version,
      module: workflow.def.module,
      trigger: workflow.def.trigger,
      graph:
        workflow.def.graph ?? kernel.workflowEngine.graphFor(workflow.def.id, workflow.def.version),
    })),
  }));
  // 19.T8: routine schedules, their receipt and explicit suggestions. The
  // scheduler owns execution; accepting a suggestion only writes settings.
  const DaysQuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(365).default(30),
  });
  app.get('/api/v1/system/schedules', async (request) => {
    const { days } = DaysQuerySchema.parse(request.query ?? {});
    return { schedules: await listSchedules(kernel, days) };
  });
  app.post('/api/v1/system/schedules/:id/run', async (request) => {
    const { id } = request.params as { id: string };
    const started = await kernel.scheduler.runNow(id, {
      actor: request.principal?.email ?? null,
    });
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'schedule.run',
      subject: id,
      payload: { runId: started.runId, trigger: 'manual' },
    });
    return { scheduleId: id, runId: started.runId };
  });
  app.get('/api/v1/system/schedules/:id/receipt', async (request) => {
    const { id } = request.params as { id: string };
    const { days } = DaysQuerySchema.parse(request.query ?? {});
    return readScheduleReceipt(kernel, id, days);
  });
  app.put('/api/v1/system/schedules/:id/suggestion', async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        suggestion: z.enum(SCHEDULE_SUGGESTIONS),
        days: z.number().int().min(1).max(365).default(30),
      })
      .strict()
      .parse(request.body ?? {});
    const accepted = await acceptScheduleSuggestion(
      kernel,
      id,
      body.suggestion,
      request.principal?.email ?? null,
      body.days,
    );
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'schedule.suggestion_accept',
      subject: id,
      payload: { suggestion: accepted.suggestion, days: accepted.days },
    });
    return { scheduleId: id, ...accepted };
  });
  app.get('/api/v1/tools', async () => kernel.tools.list());
  app.get('/api/v1/system/controls', async () => getControls(kernel.database));
  app.get('/api/v1/system/model-runtimes', async () => ({
    runtimes: await readModelRuntimes(kernel),
    controls: await getControls(kernel.database),
  }));
  app.get('/api/v1/system/dashboard-settings', async () => {
    const rows = await kernel.database
      .query<{ value: { refreshMs?: number } }>(`SELECT value FROM settings WHERE key = $1`, [
        'dashboard.settings',
      ])
      .catch(() => []);
    const refreshMs = Number(rows[0]?.value?.refreshMs ?? 600_000);
    return { refreshMs: Number.isFinite(refreshMs) ? refreshMs : 600_000 };
  });

  app.put('/api/v1/system/dashboard-settings', async (request) => {
    const body = z
      .object({ refreshMs: z.number().int().min(10_000).max(86_400_000) })
      .strict()
      .parse(request.body ?? {});
    await kernel.database.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      ['dashboard.settings', body, request.principal?.email ?? 'system'],
    );
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'dashboard.settings_update',
      subject: 'dashboard.settings',
      payload: { refreshMs: body.refreshMs },
    });
    return body;
  });

  // Approval policy (15.T3): modes, allowlist and hard-floor rows live in the
  // settings table; hard-floor patterns can never be auto-approved.
  app.get('/api/v1/system/approval-policy', async () => readApprovalPolicy(kernel.database));

  app.put('/api/v1/system/approval-policy', async (request) => {
    const policy = ApprovalPolicySchema.parse(request.body ?? {});
    return writeApprovalPolicy(kernel.database, policy, request.principal?.email ?? null);
  });

  app.get('/api/v1/system/data-processing', async () => readDataProcessing(kernel));

  app.put('/api/v1/system/data-processing', async (request) => {
    const body = KbDataProcessingSchema.parse(request.body ?? {});
    await kernel.database.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [DATA_PROCESSING_KEY, body, request.principal?.email ?? 'system'],
    );
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'data_processing.update',
      subject: DATA_PROCESSING_KEY,
      payload: body,
    });
    return body;
  });

  app.get('/api/v1/system/data-policy', async () => {
    const stored = await readDataPolicy(kernel);
    return {
      classes: effectivePolicy(stored),
      overrides: stored.overrides,
      presets: Object.keys(stored.presets),
      activePreset: stored.activePreset,
      version: stored.version,
      sendGate: await readSendGateStats(kernel),
    };
  });

  app.put('/api/v1/system/data-policy', async (request) => {
    const body = PolicyUpdateSchema.parse(request.body ?? {});
    const current = await readDataPolicy(kernel);
    let overrides = body.overrides ?? current.overrides;
    const presets = { ...current.presets };
    let activePreset = current.activePreset;
    if (body.reset) {
      overrides = {};
      activePreset = null;
    }
    if (body.applyPreset !== undefined) {
      if (body.applyPreset === null) {
        overrides = {};
        activePreset = null;
      } else {
        if (!presets[body.applyPreset]) {
          throw invalid(`unknown data policy preset ${body.applyPreset}`);
        }
        overrides = presets[body.applyPreset] ?? {};
        activePreset = body.applyPreset;
      }
    }
    for (const [id, override] of Object.entries(overrides)) {
      const cls = DEFAULT_DATA_CLASSES[id];
      if (!cls) throw invalid(`unknown data class ${id}`);
      const problem = validateOverride(cls, override);
      if (problem) throw invalid(problem);
    }
    if (body.savePreset) {
      presets[body.savePreset] = overrides;
      activePreset = body.savePreset;
    }
    const next: StoredDataPolicy = {
      version: current.version + 1,
      overrides,
      presets,
      activePreset,
    };
    await kernel.database.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [DATA_POLICY_KEY, next, request.principal?.email ?? 'system'],
    );
    policyCache = { value: next, at: Date.now() };
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'data_policy.update',
      subject: 'dataPolicy',
      payload: { version: next.version, activePreset, custom: Object.keys(overrides) },
    });
    return {
      classes: effectivePolicy(next),
      overrides: next.overrides,
      presets: Object.keys(next.presets),
      activePreset: next.activePreset,
      version: next.version,
      sendGate: await readSendGateStats(kernel),
    };
  });
  app.put('/api/v1/system/controls', async (request) => {
    const parsed = ControlsPatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw invalid('invalid controls patch', parsed.error.issues);
    }
    const body = parsed.data;
    const runtimes = body.disabledRuntimes !== undefined ? await readModelRuntimes(kernel) : [];
    const patch = resolveLlmSwitch(
      body,
      runtimes.map((runtime) => runtime.id),
    );
    const next = await setControls(kernel.database, patch, request.principal?.email ?? null);
    kernel.tools.setReadOnly(next.readOnly);
    return next;
  });
  app.get('/api/v1/system/modules/health', async () => kernel.health());
  app.get('/api/v1/system/config', async (request) => {
    const body = redactValue({
      profile: kernel.config.profile,
      queue: kernel.config.queue,
      modules: kernel.config.modules,
      capabilities: kernel.config.capabilities,
      retention: kernel.config.retention,
      hosted: kernel.config.hosted,
      // 18.T8: `/config` renders these rows from metadata, not hand-written
      // JSX. The coverage test diffs the field list against the parsed schema.
      controls: {
        fields: [...KERNEL_CONFIG_FIELDS],
        catalog: CONTROL_CATALOG,
      },
      authMode: setup.authMode,
      authModeSource: setup.authModeSource,
      rateLimit: { max: config.rateLimitMax, window: config.rateLimitWindow },
    });
    // 18.T3: config export envelope (secrets are already redacted above).
    if ((request.query as { export?: string }).export === '1') {
      return { version: 1 as const, exportedAt: new Date().toISOString(), config: body };
    }
    return body;
  });
  app.post('/api/v1/system/modules/:id/uninstall', async (request) => {
    const { id } = request.params as { id: string };
    return kernel.uninstallModule(id);
  });
}
