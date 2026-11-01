/**
 * Context packer (Phase 16, ADR-0041): ceilings are ceilings, never targets.
 * Only sources the need router selects are packed; unneeded sources add zero
 * tokens. Every included item records why and whether the answer used it.
 */
export type ContextNeed =
  'none' | 'short_term' | 'knowledge' | 'memory' | 'state' | 'history' | 'logs';
export type SendDecision = 'sent' | 'redacted' | 'withheld';

export interface PackItem {
  ref: string;
  source: Exclude<ContextNeed, 'none'>;
  text: string;
  reason: string;
  relevance?: number;
  tokens: number;
  sensitivity?: 'public' | 'internal' | 'restricted' | 'secret';
  send?: SendDecision;
}

export interface ContextPack {
  needs: ContextNeed[];
  needReason: string;
  tokens: {
    core: number;
    tools: number;
    decisions: number;
    state: number;
    handoffs: number;
    memory: number;
    retrieved: number;
    history: number;
    reserve: number;
    total: number;
  };
  included: Array<PackItem & { used: boolean }>;
  pointers: string[];
  withheld: Array<{ ref: string; reason: string }>;
}

export interface PackOptions {
  coreTokens: number;
  toolsTokens?: number;
  decisionsTokens?: number;
  windowTokens: number;
  reserveShare?: number;
  needs: ContextNeed[];
  needReason: string;
  items: PackItem[];
  defaults?: { chunks: number; memories: number; turns: number };
  ceilings?: { retrieved: number; memory: number; history: number };
  memoryFloor?: number;
}

const SOURCE_CEILING: Record<
  'retrieved' | 'memory' | 'history',
  keyof NonNullable<PackOptions['ceilings']>
> = {
  retrieved: 'retrieved',
  memory: 'memory',
  history: 'history',
};

/** Cheap rules first; the small model is only needed when these are unsure. */
export function routeNeeds(
  question: string,
  flags: { hasHistory?: boolean; hasMemory?: boolean } = {},
): {
  needs: ContextNeed[];
  reason: string;
} {
  const q = question.toLowerCase();
  if (/^(format|rewrite|shorten|summari[sz]e this|translate)\b/.test(q)) {
    return { needs: ['none'], reason: 'deterministic_formatting_request' };
  }
  const followUp =
    /\b(it|that|this|they|them|those|these|same|above|earlier|previous|instead|first|second|third|last|other|option)\b|what about/i.test(
      q,
    );
  if (followUp && flags.hasHistory) {
    return { needs: ['short_term', 'history'], reason: 'follow_up_reference' };
  }
  if (/\b(remember|prefer|preference|last time|usually)\b/i.test(q) && flags.hasMemory) {
    return { needs: ['memory'], reason: 'memory_question' };
  }
  if (/\b(yesterday|today|last week|what happened|activity|log)\b/i.test(q)) {
    return { needs: ['logs'], reason: 'activity_question' };
  }
  if (/\b(task board|work item|status of the board|shared state)\b/i.test(q)) {
    return { needs: ['state'], reason: 'state_question' };
  }
  return { needs: ['knowledge'], reason: 'factual_question' };
}

export function buildContextPack(options: PackOptions): ContextPack {
  const reserve = Math.ceil(options.windowTokens * (options.reserveShare ?? 0.25));
  const available = Math.max(0, options.windowTokens - reserve - options.coreTokens);
  const ceilings = {
    retrieved: Math.floor(available * (options.ceilings?.retrieved ?? 0.25)),
    memory: Math.floor(available * (options.ceilings?.memory ?? 0.1)),
    history: Math.floor(available * (options.ceilings?.history ?? 0.15)),
  };
  const defaults = options.defaults ?? { chunks: 3, memories: 5, turns: 4 };
  const included: Array<PackItem & { used: boolean }> = [];
  const pointers: string[] = [];
  const withheld: Array<{ ref: string; reason: string }> = [];
  const tokens = {
    core: options.coreTokens,
    tools: options.toolsTokens ?? 0,
    decisions: options.decisionsTokens ?? 0,
    state: 0,
    handoffs: 0,
    memory: 0,
    retrieved: 0,
    history: 0,
    reserve,
    total: options.coreTokens,
  };

  if (options.needs.includes('none')) {
    return {
      needs: options.needs,
      needReason: options.needReason,
      tokens,
      included,
      pointers,
      withheld,
    };
  }

  const wanted: PackItem[] = [];
  for (const item of options.items) {
    if (
      !options.needs.includes(item.source) &&
      !(item.source === 'short_term' && options.needs.includes('history'))
    ) {
      continue;
    }
    if (item.send === 'withheld') {
      withheld.push({ ref: item.ref, reason: 'send_gate_withheld' });
      continue;
    }
    if (item.source === 'memory' && (item.relevance ?? 1) < (options.memoryFloor ?? 0.75)) {
      continue;
    }
    wanted.push(item);
  }

  const counts = { retrieved: 0, memory: 0, history: 0, other: 0 };
  for (const item of wanted) {
    const bucket =
      item.source === 'knowledge'
        ? 'retrieved'
        : item.source === 'memory'
          ? 'memory'
          : item.source === 'history' || item.source === 'short_term'
            ? 'history'
            : 'other';
    const ceiling = bucket === 'other' ? available : ceilings[SOURCE_CEILING[bucket]];
    const bucketTokens = bucket === 'other' ? tokens.state : tokens[bucket];
    const cap =
      bucket === 'retrieved'
        ? defaults.chunks
        : bucket === 'memory'
          ? defaults.memories
          : defaults.turns;
    if (bucket !== 'other' && counts[bucket] >= cap) {
      pointers.push(item.ref);
      continue;
    }
    if (bucketTokens + item.tokens > ceiling || tokens.total + item.tokens > available) {
      pointers.push(item.ref);
      continue;
    }
    included.push({ ...item, used: false });
    if (bucket === 'other') {
      if (item.source === 'state') tokens.state += item.tokens;
      else if (item.source === 'logs') tokens.handoffs += item.tokens;
      else tokens.handoffs += item.tokens;
    } else {
      tokens[bucket] += item.tokens;
      counts[bucket] += 1;
    }
    tokens.total += item.tokens;
  }
  return {
    needs: options.needs,
    needReason: options.needReason,
    tokens,
    included,
    pointers,
    withheld,
  };
}

/** Conservative token estimate when no tokenizer is available. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil((text.length / 4) * 1.1));
}

export interface ChatTokenBudget {
  windowTokens: number;
  reserveOutput: number;
  reserveSources: number;
  reserveSafety: number;
  available: number;
  highWaterTokens: number;
  highWaterPercent: number;
}

export function chatTokenBudget(args: {
  contextWindow: number;
  maxOutputTokens: number;
  retrievedReserve?: number;
  safetyRatio?: number;
  highWaterPercent?: number;
}): ChatTokenBudget {
  const reserveOutput = Math.max(0, args.maxOutputTokens);
  const reserveSources = Math.max(0, args.retrievedReserve ?? 0);
  const reserveSafety = Math.ceil(args.contextWindow * (args.safetyRatio ?? 0.05));
  const available = Math.max(
    0,
    args.contextWindow - reserveOutput - reserveSources - reserveSafety,
  );
  const highWaterPercent = Math.min(0.85, Math.max(0.8, args.highWaterPercent ?? 0.825));
  return {
    windowTokens: args.contextWindow,
    reserveOutput,
    reserveSources,
    reserveSafety,
    available,
    highWaterTokens: Math.floor(available * highWaterPercent),
    highWaterPercent,
  };
}

export interface ChatContextItem {
  ref: string;
  kind: 'summary' | 'pinned' | 'turn';
  text: string;
  tokens: number;
}

export interface ChatContextResult {
  text: string;
  tokens: { used: number; available: number; window: number; percent: number };
  included: Array<ChatContextItem & { used: boolean }>;
  dropped: string[];
  compactionRecommended: boolean;
}

/**
 * Ordered chat assembly (ADR-0059): summary → pinned facts → recent turns.
 * Oldest turns are dropped first; the newest turn is always kept. Items report
 * used/unused so traces can show what the model actually saw.
 */
export function buildChatContext(args: {
  summary: string | null;
  pinned?: ChatContextItem[];
  recent: ChatContextItem[];
  budget: ChatTokenBudget;
}): ChatContextResult {
  const included: Array<ChatContextItem & { used: boolean }> = [];
  const dropped: string[] = [];
  let used = 0;
  const limit = args.budget.available;
  const add = (item: ChatContextItem) => {
    if (used + item.tokens > limit) {
      dropped.push(item.ref);
      return false;
    }
    included.push({ ...item, used: false });
    used += item.tokens;
    return true;
  };

  if (args.summary) {
    add({
      ref: 'summary',
      kind: 'summary',
      text: args.summary,
      tokens: estimateTokens(args.summary),
    });
  }
  for (const item of args.pinned ?? []) add(item);

  const kept: ChatContextItem[] = [];
  for (let index = args.recent.length - 1; index >= 0; index -= 1) {
    const item = args.recent[index] as ChatContextItem;
    if (add(item)) kept.unshift(item);
  }
  // Keep the assembled text in chronological order: summary, pinned, turns.
  const ordered = [
    ...included.filter((item) => item.kind === 'summary' || item.kind === 'pinned'),
    ...kept.map(
      (item) =>
        included.find((entry) => entry.ref === item.ref) as ChatContextItem & { used: boolean },
    ),
  ].filter(Boolean);
  const sections: string[] = [];
  const summary = ordered.filter((item) => item.kind === 'summary');
  const pinned = ordered.filter((item) => item.kind === 'pinned');
  const turns = ordered.filter((item) => item.kind === 'turn');
  if (summary.length > 0) {
    sections.push(`Session summary:\n${summary.map((item) => item.text).join('\n')}`);
  }
  if (pinned.length > 0) {
    sections.push(`Known facts:\n${pinned.map((item) => item.text).join('\n')}`);
  }
  if (turns.length > 0) {
    sections.push(`Recent conversation:\n${turns.map((item) => item.text).join('\n')}`);
  }
  const percent = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return {
    text: sections.join('\n\n'),
    tokens: { used, available: limit, window: args.budget.windowTokens, percent },
    included: ordered.map((item) => ({ ...item, used: true })),
    dropped,
    compactionRecommended: used >= args.budget.highWaterTokens,
  };
}
