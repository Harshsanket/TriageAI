/**
 * Kernel configuration: profiles + module enables + capability adapters.
 * Resolution order (later wins, all fail-fast validated):
 *   kernel defaults → config file (triage.config.json) → env overrides
 * See docs/contracts/module-contract.md §5.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { configInvalid } from './errors.js';
import type { KernelConfig } from './types.js';

const queueAdapterSchema = z.object({
  adapter: z.enum(['pg-queue', 'inline', 'bullmq']).default('pg-queue'),
  pollIntervalMs: z.number().int().positive().default(250),
});

const capabilitySchema = z.object({ adapter: z.string().min(1) }).passthrough();

const profileNameSchema = z.enum(['core', 'support', 'assistant']);

const moduleConfigSchema = z.object({
  enabled: z.boolean(),
  options: z.unknown().optional(),
});

/** Profile presets apply their module set, then user config may adjust. */
export const PROFILE_PRESETS: Record<string, Record<string, boolean>> = {
  core: {},
  support: {
    support: true,
    'ai-pipeline': true,
    chat: false,
  },
  assistant: {
    chat: true,
    kb: true,
    'ai-pipeline': true,
  },
};

const daysSchema = z.number().int().positive().max(3650).nullable().default(null);

const retentionSchema = z.object({
  enabled: z.boolean().default(false),
  intervalHours: z
    .number()
    .positive()
    .max(24 * 30)
    .default(24),
  runDays: daysSchema,
  decisionDays: daysSchema,
  auditDays: daysSchema,
  candidateDays: daysSchema,
  messageDays: daysSchema,
  deadletterDays: daysSchema,
});

const hostedSchema = z.object({
  enabled: z.boolean().default(false),
  allowedProviders: z.array(z.string()).default([]),
  budgets: z
    .record(
      z.string(),
      z.object({
        dailyTokens: z.number().int().positive().optional(),
        dailyCurrency: z.number().positive().optional(),
      }),
    )
    .prefault({}),
  currency: z.string().default('USD'),
});

const egressSchema = z.object({
  allowlist: z
    .array(
      z.object({
        host: z.string().min(1),
        dataClass: z.enum(['public', 'internal', 'restricted', 'secret']).default('public'),
      }),
    )
    .default([{ host: 'api.github.com', dataClass: 'public' }]),
});

const sensitivitySchema = z.enum(['public', 'internal', 'restricted', 'secret']);

/** Per-task route (19.2); `primary`/`fallback` are `provider:model` runtime ids. */
const taskRouteSchema = z
  .object({
    primary: z.string().min(1),
    fallback: z.string().min(1).optional(),
    qualityFloor: z.number().min(0).max(1).optional(),
    maxCostPerCall: z.number().positive().optional(),
    sensitivity: sensitivitySchema.optional(),
  })
  .strict();

/** USD per 1K tokens (19.3 price table v1: input + output; cached input is free). */
const priceEntrySchema = z
  .object({
    inputPer1k: z.number().nonnegative().optional(),
    outputPer1k: z.number().nonnegative().optional(),
  })
  .strict();

const routingSchema = z
  .object({
    tasks: z.record(z.string(), taskRouteSchema).default({}),
    prices: z.record(z.string(), priceEntrySchema).optional(),
  })
  .strict();

export type RoutingTaskRoute = z.infer<typeof taskRouteSchema>;
export type RoutingPriceEntry = z.infer<typeof priceEntrySchema>;
export type RoutingConfig = z.infer<typeof routingSchema>;

const envNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** `capabilities.cache` (18.T11): memory is the default, Redis is opt-in. */
export const cacheAdapterConfigSchema = z
  .object({
    adapter: z.enum(['memory', 'redis']).default('memory'),
    maxEntries: z.number().int().positive().max(1_000_000).optional(),
    urlEnv: envNameSchema.optional(),
    namespace: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
  })
  .strict();

export type CacheAdapterConfig =
  | { adapter: 'memory'; maxEntries: number; urlEnv?: string; namespace?: string }
  | { adapter: 'redis'; maxEntries?: number; urlEnv: string; namespace: string };

/** `capabilities.blobStore` (18.T12): local filesystem by default, S3 opt-in. */
export const blobStoreAdapterConfigSchema = z
  .object({
    adapter: z.enum(['filesystem', 's3']).default('filesystem'),
    root: z.string().min(1).max(4096).optional(),
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)
      .optional(),
    endpointEnv: envNameSchema.optional(),
    accessKeyEnv: envNameSchema.optional(),
    secretKeyEnv: envNameSchema.optional(),
    region: z.string().min(1).max(64).optional(),
  })
  .strict();

export type BlobStoreAdapterConfig =
  | { adapter: 'filesystem'; root: string; bucket?: string; region?: string }
  | {
      adapter: 's3';
      root?: string;
      bucket: string;
      endpointEnv: string;
      accessKeyEnv: string;
      secretKeyEnv: string;
      region: string;
    };

function invalidAdapterConfig(section: string, error: z.ZodError): never {
  const issues = error.issues
    .map((issue) => {
      const path =
        issue.code === 'unrecognized_keys' ? `${issue.keys.join('.')}` : issue.path.join('.');
      return `  capabilities.${section}${path ? `.${path}` : ''}: ${issue.message}`;
    })
    .join('\n');
  throw configInvalid(`Invalid triage.config.json:\n${issues}`, error.issues);
}

export function parseCacheAdapterConfig(raw: unknown): CacheAdapterConfig {
  const result = cacheAdapterConfigSchema.safeParse(raw ?? {});
  if (!result.success) invalidAdapterConfig('cache', result.error);
  const value = result.data;
  if (value.adapter === 'redis') {
    return {
      ...value,
      adapter: 'redis',
      urlEnv: value.urlEnv ?? 'REDIS_URL',
      namespace: value.namespace ?? 'triageai:cache',
    };
  }
  return { ...value, adapter: 'memory', maxEntries: value.maxEntries ?? 1_000 };
}

export function parseBlobStoreAdapterConfig(raw: unknown): BlobStoreAdapterConfig {
  const result = blobStoreAdapterConfigSchema.safeParse(raw ?? {});
  if (!result.success) invalidAdapterConfig('blobStore', result.error);
  const value = result.data;
  if (value.adapter === 's3') {
    return {
      ...value,
      adapter: 's3',
      bucket: value.bucket ?? 'triageai-blobs',
      endpointEnv: value.endpointEnv ?? 'TRIAGEAI_S3_ENDPOINT',
      accessKeyEnv: value.accessKeyEnv ?? 'TRIAGEAI_S3_ACCESS_KEY',
      secretKeyEnv: value.secretKeyEnv ?? 'TRIAGEAI_S3_SECRET_KEY',
      region: value.region ?? 'us-east-1',
    };
  }
  return { ...value, adapter: 'filesystem', root: value.root ?? 'data/blobs' };
}

const getSchema = z.object({
  profile: profileNameSchema.default('core'),
  queue: queueAdapterSchema.default({ adapter: 'pg-queue', pollIntervalMs: 250 }),
  modules: z.record(z.string(), moduleConfigSchema).prefault({}),
  capabilities: z.record(z.string(), capabilitySchema).default({ queue: { adapter: 'pg-queue' } }),
  interfaces: z.array(z.string().min(1).max(60)).optional(),
  retention: retentionSchema.prefault({}),
  hosted: hostedSchema.prefault({}),
  egress: egressSchema.prefault({}),
  routing: routingSchema.prefault({}),
  agents: z
    .record(
      z.string(),
      z.object({
        displayName: z.string().min(1).max(40),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
    )
    .optional(),
  appearance: z
    .object({
      defaults: z
        .object({
          theme: z.enum(['light', 'dark', 'auto']).optional(),
          fontSize: z.enum(['small', 'default', 'large', 'xlarge']).optional(),
          motion: z.enum(['on', 'off', 'auto']).optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .optional(),
});

export type RawConfigFile = z.input<typeof getSchema>;
/** A config file after validation and defaults. */
export type ConfigFile = z.infer<typeof getSchema>;
/** The parsed config schema; `/config` coverage tests diff its keys. */
export const configFileSchema = getSchema;

const defaults = getSchema.parse({});

export function parseConfigFile(raw: unknown): z.infer<typeof getSchema> {
  const result = getSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  config.${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw configInvalid(`Invalid triage.config.json:\n${issues}`, result.error.issues);
  }
  return result.data;
}

/**
 * Load the config file. An explicit path (argument or `TRIAGEAI_CONFIG`) is
 * resolved against the cwd, then the repo root (workspace scripts run from
 * `apps/*`), and a missing explicit file fails boot — silently booting the
 * default module set instead of the one asked for hides misconfiguration.
 * Without an explicit path, `triage.config.json` in the cwd or repo root is
 * used, else kernel defaults.
 */
export function loadConfigFile(
  path?: string,
  logger?: { warn(u: unknown, m?: string): void },
): z.infer<typeof getSchema> {
  const explicit = path ?? process.env.TRIAGEAI_CONFIG;
  const roots = [process.cwd(), resolve(process.cwd(), '../..')];
  const candidates = explicit
    ? roots.map((root) => resolve(root, explicit))
    : roots.map((root) => resolve(root, 'triage.config.json'));

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    if (explicit) {
      throw configInvalid(`Config file ${explicit} not found (looked in ${candidates.join(', ')})`);
    }
    logger?.warn({ candidates }, 'no triage.config.json found; using defaults');
    return defaults;
  }
  try {
    return parseConfigFile(JSON.parse(readFileSync(found, 'utf8')) as unknown);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw configInvalid(`Config file ${found} is not valid JSON: ${err.message}`);
    }
    throw err;
  }
}

const overlaySchema = z
  .object({
    profile: profileNameSchema.optional(),
    queue: queueAdapterSchema.partial().optional(),
    modules: z.record(z.string(), moduleConfigSchema.partial()).optional(),
    capabilities: z.record(z.string(), capabilityPatchSchema()).optional(),
    interfaces: z.array(z.string().min(1).max(60)).optional(),
    retention: retentionSchema.partial().optional(),
    hosted: hostedSchema.partial().optional(),
    egress: egressSchema.partial().optional(),
    routing: routingSchema.partial().optional(),
    agents: z
      .record(
        z.string(),
        z.object({
          displayName: z.string().min(1).max(40),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        }),
      )
      .optional(),
    appearance: z
      .object({
        defaults: z
          .object({
            theme: z.enum(['light', 'dark', 'auto']).optional(),
            fontSize: z.enum(['small', 'default', 'large', 'xlarge']).optional(),
            motion: z.enum(['on', 'off', 'auto']).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

function capabilityPatchSchema() {
  return z.object({ adapter: z.string().min(1).optional() }).passthrough();
}

export type ConfigOverlay = z.infer<typeof overlaySchema>;

/** Validate an overlay on its own (wizard input) with the file's error style. */
export function parseConfigOverlay(raw: unknown): ConfigOverlay {
  const result = overlaySchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  overlay.${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw configInvalid(`Invalid config overlay:\n${issues}`, result.error.issues);
  }
  return result.data;
}

/**
 * Layer a saved-settings overlay (the `/config` wizard) on top of the config
 * file: modules and capabilities merge per key, so the overlay only names
 * what it changes. The result is re-validated exactly like a file, and env
 * overrides still apply afterwards in `buildKernelConfig` (module-contract §5).
 */
export function applyConfigOverlay(
  file: z.infer<typeof getSchema>,
  rawOverlay: unknown,
): z.infer<typeof getSchema> {
  const overlay = parseConfigOverlay(rawOverlay);
  const modules: Record<string, unknown> = { ...file.modules };
  for (const [id, patch] of Object.entries(overlay.modules ?? {})) {
    modules[id] = { ...(file.modules[id] ?? { enabled: false }), ...patch };
  }
  const capabilities: Record<string, unknown> = { ...file.capabilities };
  for (const [id, patch] of Object.entries(overlay.capabilities ?? {})) {
    capabilities[id] = { ...file.capabilities[id], ...patch };
  }
  const agents = { ...file.agents, ...overlay.agents };
  const routing: RoutingConfig = {
    tasks: { ...file.routing.tasks, ...overlay.routing?.tasks },
    ...(Object.keys({ ...file.routing.prices, ...overlay.routing?.prices }).length > 0
      ? { prices: { ...file.routing.prices, ...overlay.routing?.prices } }
      : {}),
  };
  return parseConfigFile({
    profile: overlay.profile ?? file.profile,
    queue: { ...file.queue, ...overlay.queue },
    modules,
    capabilities,
    ...((overlay.interfaces ?? file.interfaces)
      ? { interfaces: overlay.interfaces ?? file.interfaces }
      : {}),
    retention: { ...file.retention, ...overlay.retention },
    hosted: { ...file.hosted, ...overlay.hosted },
    egress: { ...file.egress, ...overlay.egress },
    routing,
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    ...((overlay.appearance ?? file.appearance)
      ? { appearance: overlay.appearance ?? file.appearance }
      : {}),
  });
}

/** Merge presets + file + env overrides into the kernel config. */
export function buildKernelConfig(
  file: z.infer<typeof getSchema>,
  env: NodeJS.ProcessEnv = process.env,
): KernelConfig & { routing: RoutingConfig } {
  const preset = PROFILE_PRESETS[file.profile] ?? {};
  const modules: Record<string, { enabled: boolean; options?: unknown }> = {};

  for (const [id, enabled] of Object.entries(preset)) {
    modules[id] = { enabled };
  }
  for (const [id, mod] of Object.entries(file.modules)) {
    modules[id] = {
      ...modules[id],
      enabled: mod.enabled,
      options: mod.options ?? modules[id]?.options,
    };
  }

  const enableList = env.TRIAGEAI_ENABLE_MODULES ?? '';
  const disableList = env.TRIAGEAI_DISABLE_MODULES ?? '';
  for (const id of enableList
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    modules[id] = { ...modules[id], enabled: true };
  }
  for (const id of disableList
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    modules[id] = { ...modules[id], enabled: false };
  }

  const envAdapter = env.TRIAGEAI_QUEUE_ADAPTER;
  const adapter =
    envAdapter === 'inline' || envAdapter === 'bullmq' || envAdapter === 'pg-queue'
      ? envAdapter
      : file.queue.adapter;
  const queue: KernelConfig['queue'] = { adapter, pollIntervalMs: file.queue.pollIntervalMs };
  // Storage adapters have defaults even when the file is silent, and an
  // invalid `capabilities.cache`/`blobStore` block fails boot here.
  const capabilities: KernelConfig['capabilities'] = {
    ...file.capabilities,
    cache: parseCacheAdapterConfig(file.capabilities.cache),
    blobStore: parseBlobStoreAdapterConfig(file.capabilities.blobStore),
  };

  return {
    profile: file.profile,
    queue,
    modules,
    capabilities,
    retention: file.retention,
    hosted: file.hosted,
    egress: file.egress,
    routing: file.routing,
  };
}
