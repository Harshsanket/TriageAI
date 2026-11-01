/**
 * Small local LLM provider module (Phase 22.T11). The model name is config
 * (ADR-0008); the module only knows the local Ollama chat wire shape and
 * provides the `chatModel` capability behind the router.
 */
import { z } from 'zod';

import { AppError, internal } from '@triageai/kernel';
import type { ChatModel, ChatRequest, ChatResponse, TriageModule } from '@triageai/kernel';

const configSchema = z
  .object({
    baseUrl: z.string().url().default('http://localhost:11434'),
    model: z.string().min(1).default('qwen2.5:1.5b'),
    timeoutMs: z.number().int().positive().max(300_000).default(120_000),
    contextWindow: z.number().int().positive().default(8192),
    maxOutput: z.number().int().positive().default(1024),
  })
  .strict();

type Config = z.infer<typeof configSchema>;

function createOllamaChatModel(
  config: Config,
  fetchImpl: typeof fetch,
  controls: () => Promise<{ llmDisabled?: boolean; disabledRuntimes?: string[] } | null>,
): ChatModel {
  const runtimeId = `llm-local:${config.model}`;
  return {
    describe() {
      return {
        provider: 'llm-local',
        model: config.model,
        hosted: false,
        contextWindow: config.contextWindow,
        maxOutput: config.maxOutput,
        supportsTools: false,
        supportsStreaming: false,
      };
    },
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const state = await controls();
      if (state?.llmDisabled || state?.disabledRuntimes?.includes(runtimeId)) {
        throw new AppError(
          'models.DISABLED',
          `model runtime ${runtimeId} is disabled by the operator`,
          { runtime: runtimeId },
          503,
          {
            category: 'policy_blocked',
            retryable: false,
            userMessage: 'AI generation is turned off.',
          },
        );
      }
      const response = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          stream: false,
          options: {
            temperature: request.temperature ?? 0.2,
            num_predict: request.maxTokens ?? config.maxOutput,
          },
        }),
        signal: request.signal ?? AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        throw internal(`local chat model answered ${response.status}`);
      }
      const body = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
        done_reason?: string;
      };
      const text = body.message?.content ?? '';
      return {
        message: { role: 'assistant', content: text },
        toolCalls: [],
        usage: {
          inputTokens: body.prompt_eval_count ?? 0,
          outputTokens: body.eval_count ?? 0,
        },
        stopReason: body.done_reason === 'length' ? 'max_tokens' : 'end',
        modelVersion: config.model,
      };
    },
  };
}

export function createLlmLocalModule(options: { fetch?: typeof fetch } = {}): TriageModule {
  return {
    id: 'llm-local',
    version: '0.1.0',
    capabilities: ['egress'],
    permissions: {
      routes: [],
      events: { publish: [], subscribe: [] },
      capabilities: { consume: ['egress'], provide: ['chatModel'] },
      stages: [],
      workflows: [],
      evals: [],
      tools: [],
      knowledge: { read: [], write: [] },
    },
    dependsOn: { capabilities: [{ capability: 'egress', optional: true }] },
    configSchema,
    tables: [],
    manifest: { routes: [], nav: [], background: [] },
    lifecycle: {
      health: async () => ({ status: 'healthy', detail: 'local chat model provider' }),
    },
    register(ctx) {
      const config = configSchema.parse(ctx.moduleOptions ?? {});
      const egress = ctx.capabilities.egress;
      const fetchImpl =
        options.fetch ??
        (egress
          ? (((url: string | URL | Request, init?: RequestInit) =>
              egress.fetch(String(url), init ?? {}, { purpose: 'chatModel' })) as typeof fetch)
          : fetch);
      ctx.provideCapability(
        'chatModel',
        createOllamaChatModel(
          config,
          fetchImpl,
          () =>
            ctx.settings?.get<{ llmDisabled?: boolean; disabledRuntimes?: string[] }>('controls') ??
            Promise.resolve(null),
        ),
      );
    },
  };
}

export const llmLocalModule: TriageModule = createLlmLocalModule();
