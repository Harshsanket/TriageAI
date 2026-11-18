/**
 * Agent-step context assembly (Phase 16.T3): need router → shared packer →
 * persisted `AgentContextPackRecord`. Only selected sources are fetched; every
 * item carries a ref, a reason and its token size so used/unused can be
 * reported per step. No `SELECT *` lives here: the kernel stores own their
 * projections and this module only consumes their rows.
 */
import { createHash } from 'node:crypto';

import { buildContextPack, detect, estimateTokens, maskPii } from '@triageai/rag';
import type { ContextPack, PackItem } from '@triageai/rag';

import { classifySend } from '../data/sendGate.js';

import { MemoryStore } from '../memory/index.js';
import { SharedStateStore, WorkspaceDecisionStore } from '../state/index.js';
import type { Database } from '../types.js';
import { routeAgentNeeds, recordContextPack, type AgentContextPackRecord } from './need.js';
import type { AgentDefinition, AgentState } from './runtime.js';

export interface AgentContextSources {
  database: Database;
  workspaceId?: string;
  agentId?: string;
}

export interface AgentStepContext {
  pack: ContextPack;
  record: AgentContextPackRecord;
  /** Included item text only; pointers are listed without payloads. */
  promptText: string;
}

function sensitivity(value: string): PackItem['sensitivity'] {
  return value === 'public' || value === 'restricted' || value === 'secret' ? value : 'internal';
}

/**
 * Build the pack for one step. Short-term notes are always available; long-term
 * stores are touched only when the need router selected their source.
 */
export async function buildAgentStepContext(args: {
  definition: AgentDefinition;
  goal: string;
  state: AgentState;
  step: number;
  lastDecision?: string;
  lastTool?: string;
  hosted: boolean;
  windowTokens: number;
  /** Run trigger; `schedule` disables chat-history/short-term notes (18.T33). */
  trigger?: string;
  sources?: AgentContextSources;
}): Promise<AgentStepContext> {
  const { definition, goal, state, sources } = args;
  const allowHistory = args.trigger !== 'schedule';
  const needs = routeAgentNeeds({
    goal,
    step: args.step,
    ...(args.lastDecision ? { lastDecision: args.lastDecision } : {}),
    ...(args.lastTool ? { lastTool: args.lastTool } : {}),
    hasHistory: allowHistory && state.notes.length > 0,
    hasMemory: Boolean(sources?.workspaceId ?? sources?.agentId),
    hasState: Boolean(sources?.workspaceId),
  });

  const coreTokens = estimateTokens(
    [
      definition.profile,
      definition.job.role,
      definition.job.inputs,
      definition.job.output,
      definition.job.doneWhen,
      definition.job.domain,
      goal,
      `step ${args.step + 1}/${definition.maxSteps}`,
    ].join('\n'),
  );
  const items: PackItem[] = [];

  const wantsShort =
    allowHistory && needs.needs.some((need) => ['short_term', 'history', 'logs'].includes(need));
  if (wantsShort) {
    for (const [index, note] of state.notes.entries()) {
      items.push({
        ref: `step:${index + 1}`,
        source: 'short_term',
        text: note,
        reason: 'recent_step',
        relevance: 1,
        tokens: estimateTokens(note),
      });
    }
  }

  if (needs.needs.includes('memory') && sources) {
    const scopeId = sources.workspaceId ?? sources.agentId;
    if (scopeId) {
      const hits = await new MemoryStore(sources.database).recall({
        query: goal,
        ...(sources.agentId ? { agentId: sources.agentId } : {}),
        ...(sources.workspaceId ? { workspaceId: sources.workspaceId } : {}),
        limit: 5,
        floor: 0.75,
        tokenCeiling: Math.max(0, Math.floor(args.windowTokens * 0.1)),
      });
      for (const hit of hits) {
        const memory = hit.entry;
        const level = memory.sensitivity;
        items.push({
          ref: `memory:${memory.id}`,
          source: 'memory',
          text: memory.text,
          reason: 'memory_match',
          relevance: hit.score,
          tokens: estimateTokens(memory.text),
          sensitivity: level,
          ...(args.hosted && (level === 'restricted' || level === 'secret')
            ? { send: 'withheld' as const }
            : {}),
        });
      }
    }
  }

  if (needs.needs.includes('state') && sources?.workspaceId) {
    const entries = await new SharedStateStore(sources.database).list(
      'workspace',
      sources.workspaceId,
    );
    for (const entry of entries) {
      const text = `${entry.key} = ${JSON.stringify(entry.value)}`;
      const level = sensitivity(entry.sensitivity);
      items.push({
        ref: `state:${entry.key}`,
        source: 'state',
        text,
        reason: 'workspace_state',
        relevance: 1,
        tokens: estimateTokens(text),
        sensitivity: level,
        ...(args.hosted && (level === 'restricted' || level === 'secret')
          ? { send: 'withheld' as const }
          : {}),
      });
    }
    const decisions = await new WorkspaceDecisionStore(sources.database).list(sources.workspaceId);
    for (const decision of decisions.slice(-10)) {
      const text = `${decision.decision} — ${decision.reason}`;
      items.push({
        ref: `decision:${decision.id}`,
        source: 'state',
        text,
        reason: 'workspace_decision',
        relevance: 1,
        tokens: estimateTokens(text),
        sensitivity: 'internal',
      });
    }
  }

  const pack = buildContextPack({
    coreTokens,
    windowTokens: args.windowTokens,
    needs: needs.needs,
    needReason: needs.reason,
    items: gateContextItems(items, args.hosted),
    defaults: { chunks: 3, memories: 5, turns: 4 },
    memoryFloor: 0.75,
  });
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        needs: pack.needs,
        included: pack.included.map((item) => ({ ref: item.ref, text: item.text })),
      }),
    )
    .digest('hex')
    .slice(0, 16);
  const promptText = pack.included.map((item) => `[${item.ref}] ${item.text}`).join('\n\n');
  const pointers = pack.pointers.length > 0 ? `Also available: ${pack.pointers.join(', ')}` : '';
  return {
    pack,
    record: recordContextPack(pack, hash, pack.tokens.total >= Math.floor(args.windowTokens * 0.8)),
    promptText: [promptText, pointers].filter(Boolean).join('\n\n'),
  };
}

const LEVELS = ['public', 'internal', 'restricted', 'secret'] as const;

/**
 * 18.T16: the same send gate decides what a context pack may send. Item
 * sensitivity is raised to the detector result, withheld items are flagged for
 * exclusion before packing and redacted items are masked in place.
 */
export function gateContextItems(items: PackItem[], hosted: boolean): PackItem[] {
  return items.map((item) => {
    const detection = detect(item.text);
    const severity = Math.max(
      LEVELS.indexOf(item.sensitivity ?? 'internal'),
      LEVELS.indexOf(detection.sensitivity),
    );
    const gate = classifySend({
      sensitivity: LEVELS[severity] ?? 'internal',
      tags: detection.tags,
      hosted,
    });
    if (gate.decision === 'withheld') return { ...item, send: 'withheld' as const };
    if (gate.decision === 'redacted') {
      const text = maskPii(item.text, 'prompt').text;
      return { ...item, text, tokens: estimateTokens(text) };
    }
    return item;
  });
}
