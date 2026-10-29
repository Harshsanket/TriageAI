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

const getSchema = z.object({
  profile: profileNameSchema.default('core'),
  queue: queueAdapterSchema.default({ adapter: 'pg-queue', pollIntervalMs: 250 }),
  modules: z.record(z.string(), moduleConfigSchema).default({}),
  capabilities: z.record(z.string(), capabilitySchema).default({ queue: { adapter: 'pg-queue' } }),
  retention: retentionSchema.default({}),
});

export type RawConfigFile = z.input<typeof getSchema>;

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

/** Merge presets + file + env overrides into the kernel config. */
export function buildKernelConfig(
  file: z.infer<typeof getSchema>,
  env: NodeJS.ProcessEnv = process.env,
): KernelConfig {
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

  return {
    profile: file.profile,
    queue,
    modules,
    capabilities: file.capabilities,
    retention: file.retention,
  };
}
