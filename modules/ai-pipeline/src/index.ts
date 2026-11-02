/**
 * ai-pipeline (Phase 3): embedding-similarity classification + deterministic
 * routing. No generative LLM is involved, ever (REQUIREMENTS FR-2/FR-3).
 *
 * This module owns the classification/routing configuration tables and the
 * workflow stage handlers; ticket state lives in the `support` module, which
 * consumes these stage outputs in its own `support.ticket.apply` stage.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { buildRagPrompt, finalizeAnswer, maskPii, redactPii, runValidation } from '@triageai/rag';
import {
  AppError,
  callModel,
  classifySend,
  exportOtlpTrace,
  internal,
  invalid,
  policyBlocked,
} from '@triageai/kernel';
import type { TriageModule } from '@triageai/kernel';

const configSchema = z.object({}).strict();

interface CategoryRow {
  [key: string]: unknown;
  id: string;
  label: string;
  threshold: number;
  margin: number;
  safety_critical: boolean;
  enabled: boolean;
}

interface RuleRow {
  [key: string]: unknown;
  id: string;
  rules_version: number;
  priority: number;
  category: string | null;
  team: string;
  priority_level: string;
  escalate: boolean;
}

const SEED_CATEGORIES: Array<[string, string, number, number, boolean]> = [
  ['general_question', 'General question', 0.4, 0.03, false],
  ['known_troubleshooting', 'Known troubleshooting', 0.42, 0.04, false],
  ['feature_question', 'Feature question', 0.42, 0.04, false],
  ['billing', 'Billing', 0.45, 0.05, false],
  ['bug_report', 'Bug report', 0.45, 0.05, false],
  ['security', 'Security', 0.5, 0.08, true],
  ['account', 'Account', 0.45, 0.05, false],
  ['refund_dispute', 'Refund dispute', 0.45, 0.05, false],
];

const SEED_RULES: Array<[string, number, string | null, string, string, boolean]> = [
  ['rule-security', 1, 'security', 'human-review', 'urgent', true],
  ['rule-billing', 10, 'billing', 'billing', 'high', false],
  ['rule-refund', 11, 'refund_dispute', 'billing', 'high', false],
  ['rule-bug', 20, 'bug_report', 'engineering', 'high', false],
  ['rule-account', 25, 'account', 'accounts', 'normal', false],
  ['rule-troubleshooting', 30, 'known_troubleshooting', 'support', 'normal', false],
  ['rule-feature', 40, 'feature_question', 'product', 'low', false],
  ['rule-general', 50, 'general_question', 'support', 'low', false],
  ['rule-unknown', 999, null, 'human-review', 'normal', true],
];

function ruleSql(): string {
  const values = SEED_RULES.map(
    ([id, priority, category, team, level, escalate]) =>
      `('${id}', 1, ${priority}, ${category === null ? 'NULL' : `'${category}'`}, '${team}', '${level}', ${escalate})`,
  ).join(',\n');
  return `INSERT INTO ai_routing_rules (id, rules_version, priority, category, team, priority_level, escalate)
          VALUES ${values}
          ON CONFLICT (id) DO NOTHING;`;
}

function categorySql(): string {
  const values = SEED_CATEGORIES.map(
    ([id, label, threshold, margin, safety]) =>
      `('${id}', '${label}', ${threshold}, ${margin}, ${safety})`,
  ).join(',\n');
  return `INSERT INTO ai_categories (id, label, threshold, margin, safety_critical)
          VALUES ${values}
          ON CONFLICT (id) DO NOTHING;`;
}

const MIGRATIONS = [
  {
    id: '0001-ai-pipeline-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS ai_categories (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        threshold REAL NOT NULL,
        margin REAL NOT NULL,
        safety_critical BOOLEAN NOT NULL DEFAULT false,
        enabled BOOLEAN NOT NULL DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS ai_routing_rules (
        id TEXT PRIMARY KEY,
        rules_version INT NOT NULL,
        priority INT NOT NULL,
        category TEXT,
        team TEXT NOT NULL,
        priority_level TEXT NOT NULL,
        escalate BOOLEAN NOT NULL DEFAULT false,
        enabled BOOLEAN NOT NULL DEFAULT true,
        note TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ai_policy_versions (
        version INT PRIMARY KEY,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ${categorySql()}
      INSERT INTO ai_policy_versions (version, note) VALUES (1, 'phase-3 seed') ON CONFLICT (version) DO NOTHING;
      ${ruleSql()}
    `,
    dropSql:
      'DROP TABLE IF EXISTS ai_policy_versions; DROP TABLE IF EXISTS ai_routing_rules; DROP TABLE IF EXISTS ai_categories;',
  },
];

export const aiPipelineModule: TriageModule = {
  id: 'ai-pipeline',
  version: '0.1.0',
  capabilities: ['embedder', 'classifier', 'validator', 'modelRegistry'],
  permissions: {
    storage: { schema: true },
    routes: [],
    events: { publish: [], subscribe: [] },
    capabilities: {
      consume: [
        'embedder',
        'classifier',
        'retriever',
        'generator',
        'validator',
        'modelRegistry',
        'chatModel',
        'cache',
      ],
      provide: [],
    },
    stages: [
      'ai.classify',
      'ai.finalize_answer',
      'ai.generate',
      'ai.retrieve',
      'ai.route',
      'ai.validate',
    ],
    workflows: [],
    evals: [],
    tools: [],
    knowledge: { read: ['*'], write: [] },
  },
  dependsOn: {
    capabilities: [
      { capability: 'embedder', optional: true },
      { capability: 'classifier', optional: true },
      { capability: 'retriever', optional: true },
      { capability: 'generator', optional: true },
      { capability: 'validator', optional: true },
      { capability: 'modelRegistry', optional: true },
    ],
  },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['ai_categories', 'ai_routing_rules', 'ai_policy_versions'],
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: {
    health: async () => ({
      status: 'healthy',
      detail: 'similarity classifier + deterministic routing',
    }),
  },
  register(ctx) {
    ctx.registerStageHandler('ai.classify', {
      execute: async (stage) => {
        const classifier = ctx.capabilities.classifier;
        if (!classifier) throw internal('classifier capability is not configured');
        const input = stage.input as { subject?: string; body?: string };
        const text = `${input.subject ?? ''}\n\n${input.body ?? ''}`.trim();
        if (!text) throw invalid('classify stage received empty text');

        const result = await classifier.classify(text);
        const activeModel = await ctx.capabilities.modelRegistry?.active('classifier');
        const rows = await ctx.database.query<CategoryRow>(
          `SELECT id, label, threshold, margin, safety_critical, enabled FROM ai_categories`,
        );
        const configured = new Map(rows.map((row) => [row.id, row]));
        const categoryConfig = configured.get(result.category);

        const reasonCodes: string[] = [];
        let category = result.category;
        let safetyCritical = false;
        let threshold = 0.35;
        let marginThreshold = 0.05;

        if (category === 'unknown') {
          reasonCodes.push('classifier_unknown');
        } else if (!categoryConfig || !categoryConfig.enabled) {
          reasonCodes.push('category_not_configured');
          category = 'unknown';
        } else {
          threshold = categoryConfig.threshold;
          marginThreshold = categoryConfig.margin;
          safetyCritical = categoryConfig.safety_critical;
          if (result.confidence < threshold) {
            reasonCodes.push(`below_confidence:${threshold}`);
            category = 'unknown';
          } else if (result.margin < marginThreshold) {
            reasonCodes.push(`below_margin:${marginThreshold}`);
            category = 'unknown';
          }
          if (safetyCritical) reasonCodes.push('safety_critical');
        }

        return {
          output: {
            category,
            confidence: result.confidence,
            margin: result.margin,
            method: result.method,
            modelVersion: result.modelVersion,
            safetyCritical,
            reasonCodes,
            thresholds: { confidence: threshold, margin: marginThreshold },
            policyVersion: 1,
          },
          evidence: {
            kind: 'deterministic',
            classifierMethod: result.method,
            modelVersion: result.modelVersion,
            thresholds: { confidence: threshold, margin: marginThreshold },
            reasonCodes,
          },
          deterministic: {
            thresholds: { confidence: threshold, margin: marginThreshold },
            policyVersion: 1,
            rawCategory: result.category,
            rawConfidence: result.confidence,
            rawMargin: result.margin,
          },
          adapterVersions: {
            classifier: activeModel?.name ?? result.modelVersion,
            classifierModelVersion: result.modelVersion,
            ...(activeModel
              ? {
                  classifierAssetId: activeModel.id,
                  classifierEvalReportId: activeModel.evalReportId,
                }
              : {}),
          },
        };
      },
    });

    ctx.registerStageHandler('ai.route', {
      execute: async (stage) => {
        const input = stage.input as {
          category?: string;
          safetyCritical?: boolean;
          confidence?: number;
        };
        const category = input.category ?? 'unknown';
        const versions = await ctx.database.query<{ version: number }>(
          `SELECT MAX(rules_version)::int AS version FROM ai_routing_rules`,
        );
        const rulesVersion = versions[0]?.version ?? 1;
        const rules = await ctx.database.query<RuleRow>(
          `SELECT id, rules_version, priority, category, team, priority_level, escalate
           FROM ai_routing_rules
           WHERE rules_version = $1 AND enabled AND (category = $2 OR category IS NULL)
           ORDER BY priority ASC`,
          [rulesVersion, category],
        );
        const rule = rules[0];
        const reasons: string[] = [];
        if (!rule) {
          reasons.push('no_matching_rule');
        }
        if (category === 'unknown') reasons.push('category_unknown');
        if (input.safetyCritical) reasons.push('safety_critical');

        const escalate =
          Boolean(input.safetyCritical) || category === 'unknown' || !rule || rule.escalate;
        return {
          output: {
            category,
            team: rule?.team ?? 'human-review',
            priority: rule?.priority_level ?? 'normal',
            escalate,
            ruleIds: rule ? [rule.id] : [],
            rulesVersion,
            reasons,
          },
          evidence: {
            kind: 'deterministic',
            rulesVersion,
            ruleIds: rule ? [rule.id] : [],
            category,
            reasons,
          },
          deterministic: {
            rulesVersion,
            ruleIds: rule ? [rule.id] : [],
            category,
            escalate,
          },
        };
      },
    });

    ctx.registerStageHandler('ai.retrieve', {
      execute: async (stage) => {
        const retriever = ctx.capabilities.retriever;
        const input = stage.input as {
          query?: string;
          collection?: string;
          filter?: Record<string, unknown>;
          limit?: number;
          bypassOnFailure?: boolean;
          audience?: 'public' | 'operator';
        };
        if (!input.query) throw invalid('ai.retrieve requires a query');
        if (!retriever) {
          // Chat-only mode (Phase 13.T8): no vector stack is a valid install.
          // Generation proceeds with an empty source set and says so.
          return {
            output: {
              chunks: [],
              gate: {
                sufficient: false,
                topScore: 0,
                margin: 0,
                threshold: 0,
                marginThreshold: 0,
              },
              sufficient: false,
              bypassed: true,
            },
            evidence: {
              kind: 'deterministic',
              retrievalBypassed: true,
              reason: 'retriever_missing',
            },
            deterministic: { retrievalBypassed: true, collection: input.collection ?? 'kb_docs' },
          };
        }
        // `retry_alternative_retrieval` re-runs with a broader candidate set
        // (the approved-only filter is never relaxed).
        const alternate = stage.config._alternate === true;
        const baseLimit = input.limit ?? 4;
        const limit = alternate ? Math.min(baseLimit * 2, 10) : baseLimit;
        const activeModel = await ctx.capabilities.modelRegistry?.active('retriever');
        let result;
        try {
          result = await retriever.search(input.collection ?? 'kb_docs', input.query, {
            limit,
            filter: { sourceEnabled: true, ...(input.filter ?? {}) },
            ...(input.audience ? { audience: input.audience } : {}),
          });
        } catch (err) {
          if (!input.bypassOnFailure) throw err;
          // Chat-only degradation: the vector stack is unreachable, so answer
          // through the direct generator path instead of failing the run.
          return {
            output: {
              chunks: [],
              gate: {
                sufficient: false,
                topScore: 0,
                margin: 0,
                threshold: 0,
                marginThreshold: 0,
              },
              sufficient: false,
              bypassed: true,
              retrievalError: (err as Error).message,
            },
            evidence: {
              kind: 'deterministic',
              retrievalBypassed: true,
              reason: 'retrieval_failed',
            },
            deterministic: { retrievalBypassed: true, error: (err as Error).message },
          };
        }
        // Never feed clearly-irrelevant chunks to a small generator: they make
        // it refuse or hallucinate. Keep at least the best chunk for context.
        const relevant = result.chunks.filter((chunk) => chunk.score >= result.gate.threshold);
        const selected = relevant.length > 0 ? relevant : result.chunks.slice(0, 1);
        return {
          output: {
            chunks: selected.map((chunk) => ({
              id: chunk.id,
              ref:
                (chunk.metadata.path as string | undefined) ??
                ((chunk.metadata.title as string | undefined)
                  ? `${String(chunk.metadata.title)}${chunk.metadata.headingPath ? ` (${String(chunk.metadata.headingPath)})` : ''}`
                  : undefined) ??
                chunk.documentId,
              text: chunk.text,
              score: Number(chunk.score.toFixed(4)),
              documentId: chunk.documentId,
              modelUse: (chunk.metadata.modelUse as string | undefined) ?? 'send',
            })),
            gate: result.gate,
            sufficient: result.gate.sufficient,
          },
          evidence: {
            kind: 'deterministic',
            thresholds: { score: result.gate.threshold, margin: result.gate.marginThreshold },
            topScore: Number(result.gate.topScore.toFixed(4)),
            margin: Number(result.gate.margin.toFixed(4)),
            selectedChunks: selected.length,
            retrievedChunks: result.chunks.length,
            reasons: result.gate.sufficient ? ['sufficient'] : ['insufficient_retrieval'],
          },
          deterministic: {
            collection: input.collection ?? 'kb_docs',
            limit,
            strategy: alternate ? 'alternate' : 'primary',
            filter: { sourceEnabled: true, ...(input.filter ?? {}) },
            gate: result.gate,
          },
          adapterVersions: {
            retriever: activeModel?.name ?? 'pgvector',
            ...(activeModel ? { retrieverAssetId: activeModel.id } : {}),
          },
        };
      },
    });

    ctx.registerStageHandler('ai.generate', {
      execute: async (stage) => {
        const chatModel = ctx.capabilities.chatModel;
        const generator = ctx.capabilities.generator;
        if (!chatModel && !generator) throw internal('generator capability is not configured');
        const input = stage.input as {
          question?: string;
          chunks?: Array<{
            ref?: string;
            text?: string;
            score?: number;
            modelUse?: 'send' | 'redact' | 'withhold';
          }>;
          style?: 'assistant' | 'docs';
          maxTokens?: number;
          task?: string;
          sensitivity?: 'public' | 'internal' | 'restricted' | 'secret';
          mode?: 'grounded' | 'general';
          contextBudget?: {
            usedTokens?: number;
            totalTokens?: number;
            availableTokens?: number;
            percent?: number;
            highWaterPercent?: number;
            compacted?: boolean;
            summaryVersion?: number;
            droppedTurns?: number;
          } | null;
        };
        if (!input.question) throw invalid('ai.generate requires a question');
        const chunks = (input.chunks ?? [])
          .filter((chunk) => chunk.ref && chunk.text)
          .map((chunk) => ({
            ref: chunk.ref as string,
            text: chunk.text as string,
            score: chunk.score,
            modelUse: chunk.modelUse ?? 'send',
          }));
        const sourceModelUse = chunks.some((chunk) => chunk.modelUse === 'withhold')
          ? 'never'
          : chunks.some((chunk) => chunk.modelUse === 'redact')
            ? 'redacted'
            : 'allowed';
        const activeModel = await ctx.capabilities.modelRegistry?.active('generator');
        const mode = input.mode ?? 'grounded';
        const prompt = buildRagPrompt({
          question: input.question,
          chunks: mode === 'general' ? [] : chunks,
          style: input.style,
          mode,
        });
        const started = Date.now();
        const generatorConfig = (ctx.config.capabilities.generator ?? {}) as Record<
          string,
          unknown
        >;
        const temperature = Number(generatorConfig.temperature ?? 0.2);
        const timeoutMs = Number(generatorConfig.timeoutMs ?? 120_000);
        const maxTokens = input.maxTokens ?? Number(generatorConfig.maxTokens ?? 384);
        const description = chatModel?.describe();
        const hosted = Boolean(description?.hosted);
        const sensitivity = input.sensitivity ?? 'internal';

        const controls = await ctx.settings.get<{
          hostedModelsDisabled?: boolean;
          llmDisabled?: boolean;
          disabledRuntimes?: string[];
        }>('controls');
        if (controls?.llmDisabled) {
          throw new AppError(
            'models.DISABLED',
            'all model runtimes are disabled by the operator',
            undefined,
            503,
            {
              category: 'policy_blocked',
              retryable: false,
              userMessage: 'AI generation is turned off.',
            },
          );
        }
        if (hosted && controls?.hostedModelsDisabled) {
          throw policyBlocked('hosted models are disabled by the kill switch');
        }
        const gate = classifySend({
          sensitivity,
          hosted,
          modelUse: sourceModelUse === 'never' ? 'never' : hosted ? 'redacted' : sourceModelUse,
        });
        if (gate.decision === 'withheld') {
          throw policyBlocked(`send gate withheld ${sensitivity} content (${gate.reason})`);
        }
        const outgoing =
          gate.decision === 'redacted' ? redactPii(maskPii(prompt, 'prompt').text).text : prompt;
        if (hosted) {
          const budget =
            ctx.config.hosted?.budgets?.[description?.provider ?? 'hosted']?.dailyTokens;
          if (budget) {
            const used = await ctx.costLedger.tokensToday(description?.provider);
            if (used >= budget) {
              throw new AppError(
                'BUDGET_EXCEEDED',
                `daily token budget for ${description?.provider} is exhausted`,
                { provider: description?.provider, budget },
                429,
                { category: 'budget_exceeded', retryable: false },
              );
            }
          }
        }

        let text: string;
        let modelVersion: string;
        let usage: { promptTokens?: number; completionTokens?: number; durationMs?: number } = {};
        let tokensIn = 0;
        let tokensOut = 0;
        let cacheHit = false;
        const cache = ctx.capabilities.cache;
        const cacheKey =
          chatModel && !(controls?.disabledRuntimes?.length ?? 0)
            ? `generation:${chatModel.describe().provider}:${chatModel.describe().model}:${createHash(
                'sha256',
              )
                .update(JSON.stringify({ prompt: outgoing, maxTokens, temperature }))
                .digest('hex')}`
            : null;
        const cached = cacheKey
          ? await cache?.get<{ text: string; modelVersion: string }>(cacheKey)
          : undefined;
        if (cached) {
          text = cached.text;
          modelVersion = cached.modelVersion;
          cacheHit = true;
        } else if (chatModel) {
          const result = await callModel(
            {
              chatModel,
              onTrace: async (trace) => {
                await ctx.traces
                  .record({
                    traceId: trace.traceId,
                    runId: stage.runId,
                    task: trace.task,
                    trace,
                  })
                  .catch(() => undefined);
                const endpoint = ctx.env.TRIAGEAI_OTLP_ENDPOINT;
                if (endpoint) {
                  const capture =
                    ctx.env.TRIAGEAI_TRACE_CAPTURE === 'full'
                      ? 'full'
                      : ctx.env.TRIAGEAI_TRACE_CAPTURE === 'off'
                        ? 'off'
                        : 'redacted';
                  void exportOtlpTrace(trace, endpoint, capture, ctx.capabilities.egress).catch(
                    (err: unknown) =>
                      ctx.logger.warn(
                        { err: (err as Error).message, traceId: trace.traceId },
                        'OTLP trace export failed',
                      ),
                  );
                }
              },
            },
            {
              id: input.task ?? 'answer',
              promptTemplateId: 'ai.generate',
              promptVersion: '1',
              maxOutputTokens: maxTokens,
              timeoutMs,
              requiredFields: [],
            },
            {
              runId: stage.runId,
              workflowId: stage.workflowId,
              stepName: stage.stageId,
            },
            {
              messages: [{ role: 'user', content: outgoing }],
              temperature,
              signal: stage.signal,
              expectAnswer: false,
              ...(input.contextBudget
                ? {
                    context: {
                      windowTokens: Number(input.contextBudget.totalTokens ?? 0),
                      availableTokens: Number(input.contextBudget.availableTokens ?? 0),
                      usedTokens: Number(input.contextBudget.usedTokens ?? 0),
                      percent: Number(input.contextBudget.percent ?? 0),
                      ...(input.contextBudget.highWaterPercent != null
                        ? { highWaterPercent: input.contextBudget.highWaterPercent }
                        : {}),
                      ...(input.contextBudget.compacted != null
                        ? { compacted: input.contextBudget.compacted }
                        : {}),
                      ...(input.contextBudget.summaryVersion != null
                        ? { summaryVersion: input.contextBudget.summaryVersion }
                        : {}),
                      ...(input.contextBudget.droppedTurns != null
                        ? { droppedItems: input.contextBudget.droppedTurns }
                        : {}),
                    },
                  }
                : {}),
            },
          );
          text = result.response.message.content;
          modelVersion = result.response.modelVersion;
          tokensIn = result.response.usage.inputTokens;
          tokensOut = result.response.usage.outputTokens;
          usage = { promptTokens: tokensIn, completionTokens: tokensOut };
          if (cacheKey) {
            await cache?.set(cacheKey, { text, modelVersion }, 24 * 60 * 60 * 1000);
          }
        } else {
          const result = await (generator as NonNullable<typeof generator>).generate(outgoing, {
            maxTokens,
            temperature,
            signal: stage.signal,
          });
          text = result.text;
          modelVersion = result.modelVersion;
          usage = result.usage ?? {};
          tokensIn = usage.promptTokens ?? 0;
          tokensOut = usage.completionTokens ?? 0;
        }

        const provider = description?.provider ?? 'generator';
        await ctx.costLedger
          .record({
            runId: stage.runId,
            stageId: stage.stageId,
            task: input.task ?? 'answer',
            provider,
            model: modelVersion,
            tokensIn,
            tokensOut,
          })
          .catch(() => undefined);

        return {
          output: {
            answer: text.trim(),
            modelVersion,
            citations: mode === 'general' ? [] : chunks.map((chunk) => chunk.ref),
            mode,
            generationMs: Date.now() - started,
          },
          evidence: {
            kind: 'model_generated',
            modelVersion,
            provider,
            hosted,
            egressClass: sensitivity,
            redacted: outgoing !== prompt,
            cacheHit,
            citations: chunks.map((chunk) => chunk.ref),
          },
          deterministic: {
            promptChars: outgoing.length,
            sourceRefs: chunks.map((chunk) => chunk.ref),
            usage,
            tokensIn,
            tokensOut,
            cacheHit,
            contextBudget: input.contextBudget ?? null,
          },
          adapterVersions: {
            generator: activeModel?.name ?? modelVersion,
            generatorModelVersion: modelVersion,
            ...(activeModel
              ? {
                  generatorAssetId: activeModel.id,
                  generatorEvalReportId: activeModel.evalReportId,
                }
              : {}),
          },
        };
      },
    });

    ctx.registerStageHandler('ai.validate', {
      execute: async (stage) => {
        const input = stage.input as {
          text?: string;
          answer?: string;
          question?: string;
          sources?: Array<{ ref?: string; text?: string }>;
          policy?: Record<string, unknown>;
          allowUngrounded?: boolean;
        };
        const text = input.text ?? input.answer ?? '';
        const sources = (input.sources ?? [])
          .filter((source) => source.ref && source.text)
          .map((source) => ({ ref: source.ref as string, text: source.text as string }));
        const policy = {
          ...(input.policy ?? {}),
          ...(input.allowUngrounded ? { allowUngrounded: true } : {}),
        };
        const validator = ctx.capabilities.validator;
        const report = validator
          ? await validator.validate(
              { text, sources, question: input.question, citations: sources.map((s) => s.ref) },
              policy,
            )
          : runValidation({ text, sources, question: input.question }, policy);
        return {
          output: {
            passed: report.passed,
            checks: report.checks,
            text,
            sources,
          },
          evidence: {
            kind: 'deterministic',
            checks: report.checks,
            failedChecks: report.checks
              .filter((check) => !check.passed)
              .map((check) => check.checkId),
          },
          deterministic: { policy, passed: report.passed },
        };
      },
    });

    ctx.registerStageHandler('ai.finalize_answer', {
      execute: async (stage) => {
        const input = stage.input as {
          answer?: string;
          sources?: Array<{ ref?: string; text?: string }>;
        };
        const sources = (input.sources ?? [])
          .filter((source) => source.ref && source.text)
          .map((source) => ({ ref: source.ref as string, text: source.text as string }));
        const finalized = finalizeAnswer({ answer: input.answer ?? '', sources });
        return {
          output: finalized,
          evidence: {
            kind: 'deterministic',
            grounding: {
              method: 'token_coverage',
              grounded: finalized.grounding.grounded,
              cited: finalized.grounding.cited,
              coverage: Number(finalized.grounding.coverage.toFixed(4)),
              threshold: finalized.grounding.threshold,
            },
            citationSource: finalized.citationSource,
            refused: finalized.refused,
            reason: finalized.reason ?? null,
          },
          deterministic: { sources: sources.map((source) => source.ref) },
        };
      },
    });
  },
};
