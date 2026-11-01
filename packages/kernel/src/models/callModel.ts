/**
 * The single model-call wrapper (Phase 18.9, ADR-0045).
 *
 * Every call goes through: limits, timeout, structured output validation, one
 * repair attempt, retryable-only retries, an optional fallback model, degraded
 * quality checks and a complete ModelCallTrace. Model text is never executed.
 */
import { createHash } from 'node:crypto';

import { ulid } from 'ulid';
import type { ZodType } from 'zod';

import { AppError, timeout as timeoutError } from '../errors.js';
import type { ErrorCategory } from '../errors.js';
import type { ChatModel, ChatMessage, ChatRequest, ChatResponse, KernelLogger } from '../types.js';

export interface ModelTask {
  id: string;
  promptTemplateId: string;
  promptVersion: string;
  outputSchema?: ZodType<unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
  requiredFields: string[];
}

export interface ModelCallTrace {
  traceId: string;
  runId: string;
  workflowId: string;
  workflowVersion: string;
  stepName: string;
  conversationId?: string;
  ticketId?: string;
  workspaceId?: string;
  agentId?: string;
  task: string;
  provider: string;
  modelName: string;
  modelVersion: string;
  routingReason: string;
  promptTemplateId: string;
  promptVersion: string;
  promptHash: string;
  promptText?: string;
  toolCalls: Array<{ toolName: string; toolArgs: unknown; status: 'ok' | 'error' | 'blocked' }>;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensPerSecond?: number;
  estCost: number;
  actualCost?: number;
  currency: string;
  retries: number;
  fallbackUsed: 'none' | 'repair' | 'fallback_model' | 'fallback_edge';
  errorCategory?: ErrorCategory;
  errorCode?: string;
  schemaValidFirstTry: boolean;
  qualityChecks: Array<{ check: string; passed: boolean }>;
  securityEvents: string[];
  skills?: Array<{ name: string; version: number }>;
  /** Context accounting when the caller assembles a budgeted prompt (ADR-0059). */
  context?: {
    windowTokens: number;
    availableTokens: number;
    usedTokens: number;
    percent: number;
    highWaterPercent?: number;
    compacted?: boolean;
    summaryVersion?: number;
    droppedItems?: number;
  };
  responseFinishReason?: ChatResponse['stopReason'];
  userFeedback?: { kind: 'flag' | 'thumbs_up' | 'thumbs_down'; reason?: string; at: string };
  evalScores?: Array<{ evaluator: string; score: number }>;
  at: string;
}

export interface CallModelContext {
  runId: string;
  workflowId: string;
  workflowVersion?: string;
  stepName: string;
  conversationId?: string;
  ticketId?: string;
  workspaceId?: string;
  agentId?: string;
  /** Skill names/versions loaded into this call (ADR-0060). */
  skills?: Array<{ name: string; version: number }>;
}

export interface CallModelRequest {
  messages: ChatMessage[];
  temperature?: number;
  tools?: ChatRequest['tools'];
  toolChoice?: ChatRequest['toolChoice'];
  signal?: AbortSignal;
  /** Ask for JSON that validates against task.outputSchema. */
  structured?: boolean;
  /** Set when a refusal is not an acceptable answer (quality check). */
  expectAnswer?: boolean;
  /** Optional caller-supplied language code, e.g. 'en'. */
  language?: string;
  /** Context-budget accounting copied onto the trace. */
  context?: ModelCallTrace['context'];
}

export interface CallModelResult {
  response: ChatResponse;
  trace: ModelCallTrace;
  parsed?: unknown;
  retries: number;
  fallbackUsed: ModelCallTrace['fallbackUsed'];
  qualityChecks: ModelCallTrace['qualityChecks'];
}

export interface CallModelDeps {
  chatModel: ChatModel;
  fallbackModel?: ChatModel;
  logger?: KernelLogger;
  onTrace?: (trace: ModelCallTrace) => void | Promise<void>;
  /** Price estimate hook (Phase 19 price table); default 0. */
  estimateCost?: (args: {
    provider: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
  }) => number;
}

export class ModelCallError extends AppError {
  constructor(
    readonly trace: ModelCallTrace,
    cause?: unknown,
  ) {
    super(
      trace.errorCode ?? 'model.CALL_FAILED',
      `model call ${trace.task} failed: ${trace.errorCode ?? 'unknown'}`,
      trace,
      trace.errorCategory === 'timeout' ? 504 : 503,
      {
        category: trace.errorCategory ?? 'dependency_unavailable',
        retryable:
          trace.errorCategory === 'timeout' || trace.errorCategory === 'dependency_unavailable',
        cause,
      },
    );
  }
}

const MAX_PROVIDER_ATTEMPTS = 3;

function promptHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function parseStructured(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Deterministic degraded-output checks (18.9 step 7). */
export function qualityChecks(
  response: ChatResponse,
  args: { expectAnswer?: boolean; language?: string },
): Array<{ check: string; passed: boolean }> {
  const text = response.message.content.trim();
  const checks: Array<{ check: string; passed: boolean }> = [
    { check: 'non_empty', passed: text.length > 0 },
    { check: 'not_max_tokens', passed: response.stopReason !== 'max_tokens' },
    { check: 'not_content_filtered', passed: response.stopReason !== 'content_filter' },
  ];
  if (text.length > 0) {
    const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    const trigrams = new Map<string, number>();
    for (let index = 0; index + 2 < words.length; index += 1) {
      const key = `${words[index]} ${words[index + 1]} ${words[index + 2]}`;
      trigrams.set(key, (trigrams.get(key) ?? 0) + 1);
    }
    const maxRepeat = Math.max(0, ...trigrams.values());
    checks.push({ check: 'no_repetition_loop', passed: maxRepeat < 4 });
  }
  if (args.expectAnswer) {
    checks.push({
      check: 'not_refused',
      passed: !/\b(i (cannot|can't|am unable)|i could not verify|as an ai)\b/i.test(text),
    });
  }
  if (args.language && text.length > 20) {
    const configured = args.language.toLowerCase().slice(0, 2);
    if (configured === 'en') {
      checks.push({
        check: 'language_en',
        passed: /[a-z]/i.test(text) && !/[\u4e00-\u9fff\u0600-\u06ff]/.test(text),
      });
    }
  }
  return checks;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          new AppError('model.ABORTED', 'model call aborted', undefined, 499, {
            category: 'timeout',
          }),
        );
      },
      { once: true },
    );
  });
}

function isRetryable(error: unknown): boolean {
  return error instanceof AppError && error.retryable;
}

export async function callModel(
  deps: CallModelDeps,
  task: ModelTask,
  context: CallModelContext,
  request: CallModelRequest,
): Promise<CallModelResult> {
  const promptText = request.messages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n');
  const started = Date.now();
  let retries = 0;
  let fallbackUsed: ModelCallTrace['fallbackUsed'] = 'none';
  let lastError: unknown;
  let model = deps.chatModel;
  let modelReason = 'configured_primary';
  let schemaValidFirstTry = true;

  for (let modelAttempt = 0; modelAttempt < 2; modelAttempt += 1) {
    if (modelAttempt === 1) {
      if (!deps.fallbackModel) break;
      model = deps.fallbackModel;
      modelReason = 'primary_failed_fallback_model';
      fallbackUsed = 'fallback_model';
    }
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
      if (attempt > 1) retries += 1;
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const signal = request.signal
        ? AbortSignal.any([request.signal, controller.signal])
        : controller.signal;
      try {
        const timedOut = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(timeoutError(`model task ${task.id} exceeded ${task.timeoutMs}ms`));
          }, task.timeoutMs);
        });
        let response = await Promise.race([
          model.chat({
            messages: request.messages,
            tools: request.tools,
            toolChoice: request.toolChoice,
            maxTokens: task.maxOutputTokens,
            temperature: request.temperature,
            signal,
          }),
          timedOut,
        ]);

        if (request.structured && task.outputSchema) {
          const first = parseStructured(response.message.content);
          const firstValidation = first.ok ? task.outputSchema.safeParse(first.value) : null;
          if (!first.ok || !firstValidation?.success) {
            schemaValidFirstTry = false;
            fallbackUsed = 'repair';
            const issue = first.ok
              ? firstValidation?.error?.issues
                  .map((i) => `${i.path.join('.')}: ${i.message}`)
                  .join('; ')
              : first.error;
            response = await model.chat({
              messages: [
                ...request.messages,
                { role: 'assistant', content: response.message.content },
                {
                  role: 'user',
                  content: `Your previous JSON was invalid (${issue ?? 'unknown'}). Reply with valid JSON only.`,
                },
              ],
              tools: request.tools,
              toolChoice: request.toolChoice,
              maxTokens: task.maxOutputTokens,
              temperature: 0,
              signal,
            });
            const repaired = parseStructured(response.message.content);
            const repairedValidation = repaired.ok
              ? task.outputSchema.safeParse(repaired.value)
              : null;
            if (!repaired.ok || !repairedValidation?.success) {
              throw new AppError(
                'model.INVALID_STRUCTURED_OUTPUT',
                'model output did not match the required schema after one repair',
                undefined,
                502,
                { category: 'dependency_unavailable', retryable: false },
              );
            }
            return finish(response, repairedValidation.data);
          }
          return finish(response, firstValidation.data);
        }
        return finish(response, undefined);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt >= MAX_PROVIDER_ATTEMPTS) break;
        await sleep(Math.min(2_000, 100 * 2 ** (attempt - 1)), request.signal);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    function finish(response: ChatResponse, parsed: unknown): CallModelResult {
      const description = model.describe();
      const latencyMs = Date.now() - started;
      const checks = qualityChecks(response, {
        expectAnswer: request.expectAnswer,
        language: request.language,
      });
      const failedChecks = checks.filter((check) => !check.passed);
      const trace: ModelCallTrace = {
        traceId: ulid(),
        runId: context.runId,
        workflowId: context.workflowId,
        workflowVersion: context.workflowVersion ?? '0',
        stepName: context.stepName,
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(context.ticketId ? { ticketId: context.ticketId } : {}),
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.agentId ? { agentId: context.agentId } : {}),
        task: task.id,
        provider: description.provider,
        modelName: description.model,
        modelVersion: response.modelVersion,
        routingReason: modelReason,
        promptTemplateId: task.promptTemplateId,
        promptVersion: task.promptVersion,
        promptHash: promptHash(promptText),
        toolCalls: response.toolCalls.map((call) => ({
          toolName: call.name,
          toolArgs: call.arguments,
          status: 'ok' as const,
        })),
        latencyMs,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
        tokensCached: response.usage.cachedTokens ?? 0,
        tokensPerSecond:
          latencyMs > 0 ? Number(((response.usage.outputTokens / latencyMs) * 1000).toFixed(2)) : 0,
        estCost:
          deps.estimateCost?.({
            provider: description.provider,
            model: description.model,
            tokensIn: response.usage.inputTokens,
            tokensOut: response.usage.outputTokens,
            tokensCached: response.usage.cachedTokens ?? 0,
          }) ?? 0,
        currency: 'USD',
        retries,
        fallbackUsed,
        responseFinishReason: response.stopReason,
        schemaValidFirstTry,
        qualityChecks: checks,
        securityEvents: [],
        ...(context.skills && context.skills.length > 0 ? { skills: context.skills } : {}),
        ...(request.context ? { context: request.context } : {}),
        at: new Date().toISOString(),
      };
      if (failedChecks.length > 0) {
        deps.logger?.warn(
          { traceId: trace.traceId, task: task.id, checks: failedChecks },
          'model output failed a quality check',
        );
      }
      void deps.onTrace?.(trace);
      return { response, trace, parsed, retries, fallbackUsed, qualityChecks: checks };
    }
  }

  const description = deps.chatModel.describe();
  const trace: ModelCallTrace = {
    traceId: ulid(),
    runId: context.runId,
    workflowId: context.workflowId,
    workflowVersion: context.workflowVersion ?? '0',
    stepName: context.stepName,
    task: task.id,
    provider: description.provider,
    modelName: description.model,
    modelVersion: description.model,
    routingReason: modelReason,
    promptTemplateId: task.promptTemplateId,
    promptVersion: task.promptVersion,
    promptHash: promptHash(promptText),
    toolCalls: [],
    latencyMs: Date.now() - started,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    estCost: 0,
    currency: 'USD',
    retries,
    fallbackUsed,
    errorCategory: lastError instanceof AppError ? lastError.category : 'dependency_unavailable',
    errorCode: lastError instanceof AppError ? lastError.code : 'model.CALL_FAILED',
    schemaValidFirstTry,
    qualityChecks: [],
    securityEvents: [],
    at: new Date().toISOString(),
  };
  void deps.onTrace?.(trace);
  throw new ModelCallError(trace, lastError);
}
