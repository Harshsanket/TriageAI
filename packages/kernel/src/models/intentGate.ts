/**
 * Scope and intent gate (Phase 18.9): filters → rules → small model, before any
 * expensive reasoning. Out-of-scope requests get a short message with at most
 * one small-model call and zero tool calls.
 */
import { z } from 'zod';

import { callModel, type CallModelDeps, type ModelTask } from './callModel.js';

export interface IntentScope {
  id: string;
  intents: Record<string, { keywords: string[] }>;
  outOfScopeExamples?: string[];
  refusalMessage: string;
  clarifyMessage?: string;
  maxChars?: number;
  blockedPatterns?: string[];
}

export interface IntentDecision {
  action: 'allow' | 'refuse' | 'clarify';
  intent?: string;
  confidence?: number;
  reason: string;
  modelCalls: number;
  toolCalls: 0;
}

const DEFAULT_INJECTION = [
  /ignore\s+(all\s+)?(previous\s+|prior\s+)?(instructions|rules)/i,
  /disregard\s+(the\s+)?(previous\s+|above\s+)?instructions/i,
  /reveal\s+(the\s+)?system\s+prompt/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
];

/** Deterministic filters: size, blocked patterns, injection signatures. */
export function filterRequest(scope: IntentScope, text: string): IntentDecision | null {
  if ((scope.maxChars ?? 20_000) < text.length) {
    return { action: 'refuse', reason: 'too_long', modelCalls: 0, toolCalls: 0 };
  }
  for (const pattern of scope.blockedPatterns ?? []) {
    if (new RegExp(pattern, 'i').test(text)) {
      return { action: 'refuse', reason: `blocked:${pattern}`, modelCalls: 0, toolCalls: 0 };
    }
  }
  for (const pattern of DEFAULT_INJECTION) {
    if (pattern.test(text)) {
      return { action: 'refuse', reason: 'injection_signature', modelCalls: 0, toolCalls: 0 };
    }
  }
  return null;
}

export function ruleIntent(scope: IntentScope, text: string): IntentDecision | null {
  const lower = text.toLowerCase();
  const matches = Object.entries(scope.intents)
    .map(([intent, config]) => ({
      intent,
      hits: config.keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length,
    }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  if (matches.length === 0) return null;
  const best = matches[0]!;
  const tied = matches.filter((entry) => entry.hits === best.hits);
  if (tied.length > 1) return null; // ambiguous → let the small model decide
  return {
    action: 'allow',
    intent: best.intent,
    confidence: 1,
    reason: 'keyword_rule',
    modelCalls: 0,
    toolCalls: 0,
  };
}

const GateSchema = z
  .object({
    intent: z.string(),
    inScope: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

export async function gateIntent(args: {
  scope: IntentScope;
  text: string;
  model?: CallModelDeps;
  context?: { runId: string; workflowId: string; stepName: string };
}): Promise<IntentDecision> {
  const filtered = filterRequest(args.scope, args.text);
  if (filtered) return filtered;
  const ruled = ruleIntent(args.scope, args.text);
  if (ruled) return ruled;
  if (!args.model || !args.context) {
    return {
      action: 'clarify',
      reason: 'rules_undecided_no_model',
      modelCalls: 0,
      toolCalls: 0,
    };
  }
  const task: ModelTask = {
    id: 'intent_gate',
    promptTemplateId: 'intent_gate',
    promptVersion: '1',
    outputSchema: GateSchema,
    maxOutputTokens: 64,
    timeoutMs: 5_000,
    requiredFields: [],
  };
  try {
    const result = await callModel(args.model, task, args.context, {
      messages: [
        {
          role: 'system',
          content: `Classify the user request as JSON {intent, inScope, confidence}. Allowed intents: ${Object.keys(
            args.scope.intents,
          ).join(', ')}.`,
        },
        { role: 'user', content: args.text },
      ],
      structured: true,
      temperature: 0,
    });
    const parsed = result.parsed as z.infer<typeof GateSchema>;
    if (!parsed.inScope || parsed.confidence < 0.5) {
      return {
        action: parsed.confidence < 0.3 ? 'refuse' : 'clarify',
        intent: parsed.intent,
        confidence: parsed.confidence,
        reason: 'model_out_of_scope',
        modelCalls: 1,
        toolCalls: 0,
      };
    }
    return {
      action: 'allow',
      intent: parsed.intent,
      confidence: parsed.confidence,
      reason: 'model_decision',
      modelCalls: 1,
      toolCalls: 0,
    };
  } catch {
    return {
      action: 'clarify',
      reason: 'model_unavailable',
      modelCalls: 1,
      toolCalls: 0,
    };
  }
}

export function scopeMessage(scope: IntentScope, decision: IntentDecision): string {
  return decision.action === 'refuse' || decision.action === 'clarify'
    ? decision.action === 'clarify'
      ? (scope.clarifyMessage ?? scope.refusalMessage)
      : scope.refusalMessage
    : '';
}
