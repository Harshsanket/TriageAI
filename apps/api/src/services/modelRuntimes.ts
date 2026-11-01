/**
 * Model runtime inventory (ADR-0058): one read model for `/config` Models,
 * the dashboard LLM status and per-runtime kill switches. Names stay
 * config-bound (ADR-0008); nothing here invents a model.
 */
import type { Kernel } from '@triageai/kernel';

import { getControls, type Controls } from './controls.js';

export interface ModelRuntime {
  id: string;
  adapter: string;
  model: string;
  baseUrl: string | null;
  hosted: boolean;
  contextWindow: number | null;
  maxOutput: number | null;
  features: string[];
  status: 'running' | 'ready' | 'disabled' | 'unreachable';
  enabled: boolean;
  source: 'config' | 'runtimes' | 'module';
  lastCheckAt: string | null;
}

interface RuntimeConfig {
  id?: string;
  adapter?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  hosted?: unknown;
  contextWindow?: unknown;
  maxOutput?: unknown;
}

const LOCAL_ADAPTERS = new Set(['ollama', 'lmstudio', 'openai_compatible_local']);
const HOSTED_ADAPTERS = new Set(['openai', 'anthropic', 'google', 'openai_compatible']);

function features(kernel: Kernel): string[] {
  const enabled = new Set(kernel.modules);
  const values: string[] = [];
  if (enabled.has('chat')) values.push('chat');
  if (enabled.has('support')) values.push('support');
  if (enabled.has('doc-assistant')) values.push('doc-assistant');
  if (enabled.has('public-api')) values.push('public-api');
  if (enabled.has('emailer')) values.push('emailer');
  values.push('agents');
  return values;
}

function runtimeId(adapter: string, model: string, explicit?: string): string {
  if (explicit) return explicit;
  return `${adapter}:${model}`;
}

export function runtimeEntries(kernel: Kernel): RuntimeConfig[] {
  const config = kernel.config.capabilities as Record<string, unknown>;
  const rows = Array.isArray(config.runtimes) ? (config.runtimes as RuntimeConfig[]) : [];
  if (rows.length > 0) return rows;
  const single = (config.chatModel ?? config.generator) as RuntimeConfig | undefined;
  return single ? [single] : [];
}

function toRuntime(
  entry: RuntimeConfig,
  controls: Controls,
  lastCheck: Map<string, { at: Date | string; ok: boolean }>,
  served: string[],
): ModelRuntime | null {
  const adapter = String(entry.adapter ?? '');
  const model = String(entry.model ?? '');
  if (!adapter || !model) return null;
  const id = runtimeId(adapter, model, entry.id);
  const hosted = Boolean(entry.hosted ?? HOSTED_ADAPTERS.has(adapter));
  const disabled =
    controls.llmDisabled ||
    (controls.hostedModelsDisabled && hosted) ||
    (controls.disabledRuntimes ?? []).includes(id);
  const probe = lastCheck.get(`model:${adapter}`) ?? lastCheck.get(`model:${id}`);
  const status: ModelRuntime['status'] = disabled
    ? 'disabled'
    : !hosted &&
        probe &&
        probe.ok === false &&
        Date.now() - new Date(probe.at).getTime() < 15 * 60_000
      ? 'unreachable'
      : controls.llmDisabled
        ? 'disabled'
        : 'ready';
  return {
    id,
    adapter,
    model,
    baseUrl: entry.baseUrl ? String(entry.baseUrl) : null,
    hosted,
    contextWindow: entry.contextWindow == null ? null : Number(entry.contextWindow),
    maxOutput: entry.maxOutput == null ? null : Number(entry.maxOutput),
    features: served,
    status,
    enabled: !disabled,
    source: 'runtimes',
    lastCheckAt: probe ? new Date(probe.at).toISOString() : null,
  };
}

export async function readModelRuntimes(kernel: Kernel): Promise<ModelRuntime[]> {
  const controls = await getControls(kernel.database);
  const entries = runtimeEntries(kernel);
  const probes = await kernel.database
    .query<{ target: string; at: Date | string; ok: boolean }>(
      `SELECT DISTINCT ON (target) target, at, ok FROM uptime_probes
        WHERE target LIKE 'model:%' ORDER BY target, at DESC`,
    )
    .catch(() => []);
  const lastCheck = new Map(probes.map((row) => [row.target, { at: row.at, ok: row.ok }]));
  const served = features(kernel);
  const runtimes = entries
    .map((entry) => toRuntime(entry, controls, lastCheck, served))
    .filter((entry): entry is ModelRuntime => entry !== null);

  // A module-provided runtime (llm-local) is configured on the module, not in
  // capabilities; surface it as a separate, provider-module source.
  const modules = kernel.config.modules as Record<
    string,
    { enabled?: boolean; options?: Record<string, unknown> }
  >;
  if (modules['llm-local']?.enabled && !runtimes.some((runtime) => runtime.source === 'module')) {
    const options = modules['llm-local'].options ?? {};
    const adapter = String(options.adapter ?? 'llm-local');
    const model = String(options.model ?? '');
    if (model) {
      const id = runtimeId(adapter, model, options.id ? String(options.id) : undefined);
      const disabled = controls.llmDisabled || (controls.disabledRuntimes ?? []).includes(id);
      runtimes.push({
        id,
        adapter,
        model,
        baseUrl: options.baseUrl ? String(options.baseUrl) : null,
        hosted: false,
        contextWindow: options.contextWindow == null ? null : Number(options.contextWindow),
        maxOutput: options.maxOutput == null ? null : Number(options.maxOutput),
        features: served,
        status: disabled ? 'disabled' : 'ready',
        enabled: !disabled,
        source: 'module',
        lastCheckAt: lastCheck.get(`model:${adapter}`)
          ? new Date(lastCheck.get(`model:${adapter}`)!.at).toISOString()
          : null,
      });
    }
  }
  return runtimes;
}

export function isRuntimeDisabled(controls: Controls, id: string): boolean {
  return Boolean(controls.llmDisabled || (controls.disabledRuntimes ?? []).includes(id));
}

export function runtimeIdFor(adapter: string, model: string, explicit?: string): string {
  return runtimeId(adapter, model, explicit);
}

export { LOCAL_ADAPTERS, HOSTED_ADAPTERS };
