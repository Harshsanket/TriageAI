/** Kernel introspection + admin surface: manifest, modules, config, uninstall. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { KbDataProcessingSchema } from '@triageai/contracts';
import type { DataClass, Kernel, ModelUse, Sensitivity } from '@triageai/kernel';

import { DEFAULT_DATA_CLASSES, invalid } from '@triageai/kernel';

import { config } from '../platform/config.js';
import { writeAudit } from '../services/audit.js';
import { readModelRuntimes } from '../services/modelRuntimes.js';
import { getControls, resolveLlmSwitch, setControls } from '../services/controls.js';
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

async function readDataPolicy(kernel: Kernel): Promise<StoredDataPolicy> {
  const rows = await kernel.database
    .query<{ value: StoredDataPolicy }>(`SELECT value FROM settings WHERE key = $1`, [
      DATA_POLICY_KEY,
    ])
    .catch(() => []);
  const stored = rows[0]?.value;
  return stored && typeof stored === 'object'
    ? {
        version: Number(stored.version ?? 0),
        overrides: stored.overrides ?? {},
        presets: stored.presets ?? {},
        activePreset: stored.activePreset ?? null,
      }
    : { version: 0, overrides: {}, presets: {}, activePreset: null };
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
      sendGate: { sent: 0, redacted: 0, withheld: 0 },
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
      sendGate: { sent: 0, redacted: 0, withheld: 0 },
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
  app.get('/api/v1/system/config', async () =>
    redactValue({
      profile: kernel.config.profile,
      queue: kernel.config.queue,
      modules: kernel.config.modules,
      capabilities: kernel.config.capabilities,
      authMode: setup.authMode,
      authModeSource: setup.authModeSource,
      rateLimit: { max: config.rateLimitMax, window: config.rateLimitWindow },
    }),
  );
  app.post('/api/v1/system/modules/:id/uninstall', async (request) => {
    const { id } = request.params as { id: string };
    return kernel.uninstallModule(id);
  });
}
