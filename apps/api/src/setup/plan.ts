/**
 * Wizard answers → config overlay (ADR-0024). The overlay names only what the
 * wizard decides — modules and capability adapters — and is validated with the
 * same kernel resolver the boot uses, so a plan that passes here boots.
 */
import type { ParsedSetupAnswers, SetupPlan } from '@triageai/contracts';
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

  if (wants.has('chatbot')) ['chat', 'kb', 'ai-pipeline'].forEach((id) => enable.add(id));
  if (wants.has('ticket-solver')) ['support', 'ai-pipeline'].forEach((id) => enable.add(id));
  if (wants.has('doc-assistant')) enable.add('doc-assistant');
  if (wants.has('notifications-github')) enable.add('integrations-github');
  if (wants.has('notifications-slack')) enable.add('integrations-slack');
  if (needsRetrieval) enable.add('kb');

  if (
    (wants.has('notifications-github') || wants.has('notifications-slack')) &&
    !enable.has('support')
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
  const overlay = { profile, modules: overlayModules, capabilities };

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
    problems,
    warnings,
    secrets,
  };
}
