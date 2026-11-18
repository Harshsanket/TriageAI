/**
 * Need router for the agent step (Phase 16.T3): decide which context sources
 * this step actually needs before fetching anything. Rules first; the labels
 * mirror the shared packer (`@triageai/rag`) and every skipped source adds
 * zero tokens. The choice and its reason are persisted with the step.
 */
import type { ContextNeed, ContextPack } from '@triageai/rag';

export type AgentContextNeed = ContextNeed;

export interface AgentNeedInput {
  goal: string;
  step: number;
  /** Decision label from the previous step (`call_tool`, `done`, …). */
  lastDecision?: string;
  /** Tool the previous step called, when it called one. */
  lastTool?: string;
  hasHistory?: boolean;
  hasMemory?: boolean;
  hasState?: boolean;
}

export interface AgentNeedRouting {
  needs: AgentContextNeed[];
  reason: string;
}

/**
 * Cheap, deterministic rules for one agent step:
 * - a step right after a tool observation is a reasoning step: only the
 *   short-term notes it already produced are needed;
 * - formatting/final-answer work needs nothing extra;
 * - follow-ups, memory questions, activity and board questions opt in to
 *   exactly the matching long-term source;
 * - everything else is a factual step that may retrieve knowledge.
 */
export function routeAgentNeeds(input: AgentNeedInput): AgentNeedRouting {
  const question = input.goal.toLowerCase();
  if (input.lastDecision === 'call_tool') {
    return { needs: ['short_term'], reason: 'observe_tool_result' };
  }
  if (/^(format|rewrite|shorten|summari[sz]e this|translate|answer|reply)\b/.test(question)) {
    return { needs: ['none'], reason: 'deterministic_formatting_request' };
  }
  const followUp =
    /\b(it|that|this|they|them|those|these|same|above|earlier|previous|instead|first|second|third|last|other|option)\b|what about/i.test(
      question,
    );
  if (followUp && (input.hasHistory ?? input.step > 0)) {
    return { needs: ['short_term', 'history'], reason: 'follow_up_reference' };
  }
  if (/\b(remember|prefer|preference|last time|usually)\b/i.test(question) && input.hasMemory) {
    return { needs: ['memory'], reason: 'memory_question' };
  }
  if (/\b(yesterday|today|last week|what happened|activity|log)\b/i.test(question)) {
    return { needs: ['logs'], reason: 'activity_question' };
  }
  if (
    /\b(task board|work item|status of the board|shared state|workspace)\b/i.test(question) &&
    input.hasState
  ) {
    return { needs: ['state'], reason: 'state_question' };
  }
  if (input.step > 0 && (input.hasHistory ?? false)) {
    return { needs: ['short_term'], reason: 'continue_working' };
  }
  return { needs: ['knowledge'], reason: 'factual_question' };
}

/** One persisted pack: refs, sizes and used/unused flags, never full payloads. */
export interface AgentContextPackRecord {
  needs: AgentContextNeed[];
  needReason: string;
  hash: string;
  tokens: ContextPack['tokens'];
  included: Array<{
    ref: string;
    source: string;
    reason: string;
    tokens: number;
    used: boolean;
  }>;
  pointers: string[];
  withheld: Array<{ ref: string; reason: string }>;
  /** True when the pack reached the 80% high-water mark; the next step should
   * compact rather than add more sources. */
  compactionRecommended: boolean;
}

/** Convert a built pack into the record stored with the step. */
export function recordContextPack(
  pack: ContextPack,
  hash: string,
  compactionRecommended = false,
): AgentContextPackRecord {
  return {
    needs: pack.needs,
    needReason: pack.needReason,
    hash,
    tokens: pack.tokens,
    included: pack.included.map((item) => ({
      ref: item.ref,
      source: item.source,
      reason: item.reason,
      tokens: item.tokens,
      used: item.used,
    })),
    pointers: pack.pointers,
    withheld: pack.withheld,
    compactionRecommended,
  };
}

/** Mark an item used when the decision names it (e.g. a `[kb:1]` citation). */
export function markContextUsed(pack: ContextPack, decision: unknown): ContextPack {
  const text = JSON.stringify(decision ?? {});
  return {
    ...pack,
    included: pack.included.map((item) => ({
      ...item,
      used: item.used || text.includes(item.ref),
    })),
  };
}
