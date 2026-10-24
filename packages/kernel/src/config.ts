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

const getSchema = z.object({
  profile: profileNameSchema.default('core'),
  queue: queueAdapterSchema.default({ adapter: 'pg-queue', pollIntervalMs: 250 }),
  modules: z.record(z.string(), moduleConfigSchema).default({}),
  capabilities: z.record(z.string(), capabilitySchema).default({ queue: { adapter: 'pg-queue' } }),
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

export function loadConfigFile(
  path?: string,
  logger?: { warn(u: unknown, m?: string): void },
): z.infer<typeof getSchema> {
  const candidates = [
    path,
    process.env.TRIAGEAI_CONFIG,
    resolve(process.cwd(), 'triage.config.json'),
    resolve(process.cwd(), '../../triage.config.json'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as unknown;
      return parseConfigFile(raw);
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw configInvalid(`Config file ${candidate} is not valid JSON: ${err.message}`);
      }
      throw err;
    }
  }
  logger?.warn({ candidates }, 'no triage.config.json found; using defaults');
  return defaults;
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
  };
}
