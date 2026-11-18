/** Memory write validation (Phase 16.T5/T9, ADR-0036): sourced facts only,
 * volatile fields fetched live, lessons generalised, secrets never stored. */
import { detect } from '@triageai/rag';

import { invalid } from '../errors.js';
import type { MemoryKind } from './types.js';

const VOLATILE: Array<{ pattern: RegExp; liveTool: string }> = [
  { pattern: /\b(status|state)\b/i, liveTool: 'support.get_ticket' },
  { pattern: /\b(plan|tier|subscription)\b/i, liveTool: 'crm.get_deal' },
  { pattern: /\b(price|cost|balance|amount)\b/i, liveTool: 'crm.get_deal' },
  { pattern: /\b(assignee|owner|due date|quota)\b/i, liveTool: 'support.get_ticket' },
];

/** The read tool that owns a volatile field, or null for a durable fact. */
export function volatileFieldTool(text: string): string | null {
  return VOLATILE.find((entry) => entry.pattern.test(text))?.liveTool ?? null;
}

/** Minimal tool-registry shape: the rejection can prove the live source is a
 * registered read tool instead of trusting a hardcoded name. */
export interface MemoryLiveToolLookup {
  get(name: string): { access: string } | undefined;
}

export interface MemoryWriteContext {
  /** Registered tools, used to assert a volatile field's live source is read-only. */
  liveTools?: MemoryLiveToolLookup;
  /** Refs from this step's tool results (`tool:<name>:<id>`), proving a live read happened. */
  liveSourceRefs?: string[];
}

const DEFAULT_LIVE_TOOLS: MemoryLiveToolLookup = {
  get: (name) =>
    name === 'support.get_ticket' || name === 'crm.get_deal' ? { access: 'read' } : undefined,
};

const DATE =
  /\b(?:on|at)\s+\d{1,2}\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const INCIDENT_OPENER = /^(?:on|yesterday|last (?:week|month|year)|this morning)\b/i;
const ONE_OFF = /\b(?:ticket|issue|run|order|invoice|case|incident)\s*#?\s*[a-z]*-?\d{2,}\b/i;
const GENERAL_RULE =
  /\b(?:always|never|whenever|before|after (?:any|every|each)|prefer|avoid|must|should)\b/i;

/**
 * A lesson must be a general rule. A dated story is always an incident (even
 * when it ends with advice); a ticket/run reference is an incident unless the
 * text also states the general rule it taught.
 */
export function classifyLesson(text: string): 'incident' | 'principle' {
  if (DATE.test(text) || ISO_DATE.test(text) || INCIDENT_OPENER.test(text.trim()))
    return 'incident';
  if (ONE_OFF.test(text) && !GENERAL_RULE.test(text)) return 'incident';
  return 'principle';
}

export function validateMemoryInput(
  args: {
    text: string;
    sourceRefs: string[];
    kind: MemoryKind;
    confidence?: number;
  },
  context: MemoryWriteContext = {},
): void {
  if (args.text.trim().length === 0 || args.text.length > 300) {
    throw invalid('a memory entry must be 1–300 characters');
  }
  if (args.sourceRefs.length === 0) throw invalid('a memory entry needs at least one source ref');
  if (args.sourceRefs.some((ref) => typeof ref !== 'string' || ref.trim().length === 0)) {
    throw invalid('every memory source ref must be a non-empty string');
  }
  if (
    args.confidence !== undefined &&
    (!Number.isFinite(args.confidence) || args.confidence < 0 || args.confidence > 1)
  ) {
    throw invalid('memory confidence must be between 0 and 1');
  }
  const detection = detect(args.text);
  if (detection.hasSecret) {
    throw invalid('memory text looks like a secret; remove it before saving', {
      tags: detection.tags,
    });
  }
  const live = volatileFieldTool(args.text);
  if (live) {
    let liveSourceRef: string | undefined;
    const liveTools = context.liveTools ?? DEFAULT_LIVE_TOOLS;
    const tool = liveTools.get(live);
    if (!tool) {
      throw invalid(`volatile facts are not memorised; live tool ${live} is not registered`, {
        liveTool: live,
        reason: 'live_tool_missing',
      });
    }
    if (tool.access !== 'read') {
      throw invalid(`volatile facts are not memorised; ${live} is not a read tool`, {
        liveTool: live,
        access: tool.access,
        reason: 'live_tool_not_read',
      });
    }
    if (context.liveSourceRefs) {
      liveSourceRef = context.liveSourceRefs.find((ref) => ref.includes(live));
      if (!liveSourceRef) {
        throw invalid(`volatile facts need a live read result from ${live}; none was provided`, {
          liveTool: live,
          reason: 'live_read_required',
        });
      }
    }
    throw invalid(`volatile facts are not memorised; read ${live} instead`, {
      liveTool: live,
      ...(liveSourceRef ? { liveSourceRef } : {}),
    });
  }
  if (args.kind === 'lesson' && classifyLesson(args.text) === 'incident') {
    throw invalid('a lesson must be a general rule, not a dated incident');
  }
}
