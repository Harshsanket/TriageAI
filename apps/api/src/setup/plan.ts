/**
 * Wizard answers → config overlay (ADR-0024). The overlay names only what the
 * wizard decides — modules and capability adapters — and is validated with the
 * same kernel resolver the boot uses, so a plan that passes here boots.
 */
import type { ParsedSetupAnswers, SetupPlan } from '@triageai/contracts';

import { agentDefaults } from './agents.js';
import {
  applyConfigOverlay,
  buildKernelConfig,
  resolveModules,
  type ConfigFile,
  type TriageModule,
} from '@triageai/kernel';

/** Capabilities every boot has without config (KernelContext built-ins + host adapters). */
const ALWAYS_PRESENT = new Set([
  'storage',
  'queue',
  'eventBus',
  'outputChannel',
  'validator',
  'modelRegistry',
]);

const GENERATOR_ADAPTER: Record<string, string> = {
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  'openai-compatible': 'openai_compatible_local',
};

const DEFAULT_BASE_URL: Record<string, string> = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234/v1',
  'openai-compatible': 'http://localhost:8080/v1',
};

/** Env-var names the integration modules read credentials from (their option defaults). */
export const SECRET_ENV = {
  githubToken: 'GITHUB_TOKEN',
  slackWebhookUrl: 'SLACK_WEBHOOK_URL',
} as const;

/** Interface → module set (the single source used by plan/add/remove). */
export function interfaceModuleSet(
  interfaces: Iterable<string>,
  opts: { ticketAutoReply?: boolean } = {},
): Set<string> {
  const wants = new Set(interfaces);
  const enable = new Set<string>();
  if (wants.has('chatbot')) ['chat', 'kb', 'ai-pipeline'].forEach((id) => enable.add(id));
  if (wants.has('ticket-solver')) ['support', 'ai-pipeline'].forEach((id) => enable.add(id));
  if (wants.has('doc-assistant')) enable.add('doc-assistant');
  if (wants.has('notifications-github')) enable.add('integrations-github');
  if (wants.has('notifications-slack')) enable.add('integrations-slack');
  if (wants.has('emailer')) ['emailer', 'support', 'ai-pipeline'].forEach((id) => enable.add(id));
  if (wants.has('public-api')) ['public-api', 'ai-pipeline'].forEach((id) => enable.add(id));
  void opts;
  return enable;
}

const BUILT_IN_CAPABILITIES = new Set([
  'storage',
  'queue',
  'eventBus',
  'outputChannel',
  'embedder',
  'classifier',
  'vectorStore',
  'retriever',
  'generator',
  'validator',
  'chatModel',
  'modelRegistry',
  'blobStore',
  'egress',
  'cache',
]);

function addDependencyClosure(enable: Set<string>, modules: Record<string, TriageModule>): void {
  const providers = new Map<string, string>();
  for (const [id, mod] of Object.entries(modules)) {
    for (const capability of mod.permissions?.capabilities.provide ?? []) {
      providers.set(capability, id);
    }
  }
  for (const id of [...enable]) {
    for (const capability of modules[id]?.permissions?.capabilities.consume ?? []) {
      if (BUILT_IN_CAPABILITIES.has(capability)) continue;
      const provider = providers.get(capability);
      if (provider && !enable.has(provider)) enable.add(provider);
    }
  }
}

/**
 * Merge "Add to setup" / "remove interfaces" into an existing overlay. Only
 * interface-owned modules change; unrelated options, capabilities and agents
 * are preserved. The caller still validates the result with the planner.
 */
export function mergeInterfacesOverlay(
  baseOverlay: Record<string, unknown>,
  add: string[],
  remove: string[],
  modules: Record<string, TriageModule>,
): {
  overlay: Record<string, unknown>;
  enabledModules: string[];
  agents: Array<{ interface: string; displayName: string; color: string }>;
  problems: string[];
} {
  const base = baseOverlay as {
    interfaces?: string[];
    modules?: Record<string, { enabled?: boolean; options?: unknown }>;
    capabilities?: Record<string, unknown>;
    agents?: Record<string, { displayName: string; color: string }>;
  };
  const current = new Set(base.interfaces ?? []);
  for (const key of add) current.add(key);
  for (const key of remove) current.delete(key);
  const enable = interfaceModuleSet(current);
  addDependencyClosure(enable, modules);

  const problems: string[] = [];
  const overlayModules: Record<string, unknown> = {};
  for (const id of Object.keys(modules)) {
    overlayModules[id] = {
      enabled: enable.has(id),
      ...(enable.has(id) && base.modules?.[id]?.options
        ? { options: base.modules[id]?.options }
        : {}),
    };
  }
  const capabilities: Record<string, Record<string, unknown>> = {
    ...((base.capabilities ?? {}) as Record<string, Record<string, unknown>>),
  };
  if (enable.has('ai-pipeline') || enable.has('kb') || enable.has('doc-assistant')) {
    capabilities.embedder = { adapter: 'ai-service', ...(capabilities.embedder ?? {}) };
  }
  if (enable.has('support')) {
    capabilities.classifier = { adapter: 'ai-service', ...(capabilities.classifier ?? {}) };
  }
  if (enable.has('kb') || enable.has('doc-assistant')) {
    capabilities.vectorStore = { adapter: 'pgvector', ...(capabilities.vectorStore ?? {}) };
    capabilities.retriever = {
      adapter: 'pgvector',
      threshold: 0.35,
      margin: 0.05,
      ...(capabilities.retriever ?? {}),
    };
  }
  const keptAgents = Object.entries(base.agents ?? {}).filter(([key]) => current.has(key));
  const missing = [...current].filter((key) => !keptAgents.some(([agentKey]) => agentKey === key));
  const generated = agentDefaults(
    missing,
    keptAgents.map(([, agent]) => agent.displayName),
    keptAgents.map(([, agent]) => agent.color),
  );
  const agents = [
    ...keptAgents.map(([key, agent]) => ({ interface: key, ...agent })),
    ...generated,
  ];
  const overlay: Record<string, unknown> = {
    ...baseOverlay,
    interfaces: [...current],
    modules: overlayModules,
    capabilities,
    ...(agents.length > 0
      ? {
          agents: Object.fromEntries(
            agents.map((agent) => [
              agent.interface,
              { displayName: agent.displayName, color: agent.color },
            ]),
          ),
        }
      : { agents: {} }),
  };
  return { overlay, enabledModules: [...enable].sort(), agents, problems };
}

export function planSetup(
  answers: ParsedSetupAnswers,
  file: ConfigFile,
  modules: Record<string, TriageModule>,
  env: NodeJS.ProcessEnv,
): SetupPlan {
  const wants = new Set(answers.interfaces);
  const enable = new Set<string>();
  const problems: string[] = [];
  const warnings: string[] = [];
  const hasLlm = answers.llm.runtime !== 'none';
  const needsRetrieval =
    wants.has('chatbot') ||
    wants.has('doc-assistant') ||
    (wants.has('ticket-solver') && answers.ticketSolver.autoReply && hasLlm);

  for (const id of interfaceModuleSet(wants, { ticketAutoReply: answers.ticketSolver.autoReply })) {
    enable.add(id);
  }
  if (needsRetrieval) enable.add('kb');
  // Strict scoping: include the dependency closure declared by every selected
  // module so the manifest equals the planner output for every combination.
  addDependencyClosure(enable, modules);

  if (
    (wants.has('notifications-github') || wants.has('notifications-slack')) &&
    !wants.has('ticket-solver')
  ) {
    problems.push('Notifications send ticket updates, so they need the ticket solver too.');
  }
  if ((wants.has('chatbot') || wants.has('doc-assistant')) && !hasLlm) {
    problems.push('The chatbot and doc assistant write answers, so they need an LLM runtime.');
  }
  if (wants.has('ticket-solver') && answers.ticketSolver.autoReply && !hasLlm) {
    warnings.push('No LLM: tickets are classified and routed, but auto-replies stay off.');
  }

  const capabilities: Record<string, Record<string, unknown>> = {};
  if (enable.has('ai-pipeline') || enable.has('kb') || enable.has('doc-assistant')) {
    capabilities.embedder = { adapter: 'ai-service' };
  }
  if (enable.has('support')) capabilities.classifier = { adapter: 'ai-service' };
  if (enable.has('kb') || enable.has('doc-assistant')) {
    capabilities.vectorStore = { adapter: 'pgvector' };
    capabilities.retriever = { adapter: 'pgvector', threshold: 0.35, margin: 0.05 };
  }
  if (hasLlm) {
    capabilities.generator = {
      adapter: GENERATOR_ADAPTER[answers.llm.runtime],
      baseUrl: answers.llm.baseUrl ?? DEFAULT_BASE_URL[answers.llm.runtime],
      model: answers.llm.model,
    };
    if (env.TRIAGEAI_GENERATOR_BASE_URL) {
      warnings.push(
        `TRIAGEAI_GENERATOR_BASE_URL=${env.TRIAGEAI_GENERATOR_BASE_URL} is set and overrides the runtime URL chosen here.`,
      );
    }
  }

  // Name every known module so the overlay fully decides what runs.
  const overlayModules: Record<string, Record<string, unknown>> = {};
  for (const id of Object.keys(modules)) overlayModules[id] = { enabled: enable.has(id) };
  if (enable.has('support') && needsRetrieval) {
    overlayModules.support = { enabled: true, options: { defaultCollection: 'kb_docs' } };
  }
  if (enable.has('integrations-github') && answers.integrations.githubRepo) {
    overlayModules['integrations-github'] = {
      enabled: true,
      options: { repo: answers.integrations.githubRepo },
    };
  }
  const profile = enable.has('support') ? 'support' : enable.has('chat') ? 'assistant' : 'core';
  const chosen = [...wants];
  const providedAgents = (answers.agents ?? []).filter((agent) =>
    chosen.includes(agent.interface as (typeof chosen)[number]),
  );
  const missing = chosen.filter((key) => !providedAgents.some((agent) => agent.interface === key));
  const generated =
    missing.length > 0
      ? agentDefaults(
          missing,
          providedAgents.map((agent) => agent.displayName),
          providedAgents.map((agent) => agent.color),
        )
      : [];
  const agents = [...providedAgents, ...generated];
  const seenNames = new Set<string>();
  for (const agent of agents) {
    const normalized = agent.displayName.trim().toLowerCase();
    if (seenNames.has(normalized)) {
      problems.push(`agent name "${agent.displayName}" is used more than once`);
    }
    seenNames.add(normalized);
  }
  const overlay = {
    profile,
    interfaces: chosen,
    modules: overlayModules,
    capabilities,
    ...(agents.length > 0
      ? {
          agents: Object.fromEntries(
            agents.map((agent) => [
              agent.interface,
              { displayName: agent.displayName, color: agent.color },
            ]),
          ),
        }
      : {}),
  };

  const secrets: string[] = [];
  if (answers.integrations.githubToken) secrets.push(SECRET_ENV.githubToken);
  if (answers.integrations.slackWebhookUrl) secrets.push(SECRET_ENV.slackWebhookUrl);
  if (enable.has('integrations-github') && !answers.integrations.githubToken && !env.GITHUB_TOKEN) {
    warnings.push('GitHub has no token yet: issues stay queued until GITHUB_TOKEN is set.');
  }
  if (
    enable.has('integrations-slack') &&
    !answers.integrations.slackWebhookUrl &&
    !env.SLACK_WEBHOOK_URL
  ) {
    warnings.push('Slack has no webhook URL yet: notifications stay queued until it is set.');
  }

  // Dry-run the boot's own validation against file + overlay + env.
  try {
    const kernelConfig = buildKernelConfig(applyConfigOverlay(file, overlay), env);
    const resolution = resolveModules(kernelConfig, modules);
    problems.push(...(resolution.error ?? []));
    for (const resolved of resolution.ordered) {
      for (const dep of resolved.module.dependsOn.capabilities ?? []) {
        if (dep.optional || ALWAYS_PRESENT.has(dep.capability)) continue;
        if (!kernelConfig.capabilities[dep.capability]) {
          problems.push(
            `module "${resolved.module.id}" needs capability "${dep.capability}", which this plan does not configure`,
          );
        }
      }
    }
  } catch (err) {
    problems.push((err as Error).message);
  }

  if (answers.knowledge.documents.length > 0 && !enable.has('kb')) {
    warnings.push('Uploaded documents are only imported when a knowledge base is enabled.');
  }

  return {
    overlay,
    enabledModules: [...enable].sort(),
    agents,
    problems,
    warnings,
    secrets,
  };
}
