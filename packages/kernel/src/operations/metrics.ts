/** Coordination overhead and routine receipts (Phase 17/18/19). */
export interface CoordinationInput {
  supervisionTokens: number;
  handoffTokens: number;
  reviewTokens: number;
  taskTokens: number;
}

export interface CoordinationResult {
  overhead: number;
  alert: boolean;
}

/** Overhead = supervision + handoffs + reviews ÷ task tokens. */
export function coordinationOverhead(
  input: CoordinationInput,
  threshold = 0.3,
): CoordinationResult {
  const overheadTokens = input.supervisionTokens + input.handoffTokens + input.reviewTokens;
  const total = input.taskTokens + overheadTokens;
  if (total === 0) return { overhead: 0, alert: false };
  const overhead = Number((overheadTokens / Math.max(1, input.taskTokens)).toFixed(4));
  return { overhead, alert: overhead > threshold };
}

export interface RoutineWindow {
  runs: number;
  noChange: number;
  useful: number;
  neededHuman: number;
  repeatedFailures: number;
  skippedOverlap: number;
  manualRuns: number;
  cost: number;
  lastUsefulAt?: string | null;
  hasProbe?: boolean;
  intervalMinutes?: number;
  modelCalling?: boolean;
}

export interface RoutineReceipt extends RoutineWindow {
  costPerUsefulRun: number | null;
  usefulRunRate: number;
  suggestion: 'keep' | 'slow_down' | 'event_trigger' | 'add_probe' | 'retire';
  estSaving?: number;
  daysSinceUseful?: number | null;
}

export function routineReceipt(window: RoutineWindow, now = new Date()): RoutineReceipt {
  const usefulRunRate = window.runs === 0 ? 0 : window.useful / window.runs;
  const costPerUsefulRun = window.useful === 0 ? null : window.cost / window.useful;
  const daysSinceUseful = window.lastUsefulAt
    ? Math.floor((now.getTime() - new Date(window.lastUsefulAt).getTime()) / 86_400_000)
    : null;
  let suggestion: RoutineReceipt['suggestion'] = 'keep';
  let estSaving: number | undefined;
  if (window.useful === 0 && (daysSinceUseful === null || daysSinceUseful >= 30)) {
    suggestion = 'retire';
    estSaving = window.cost;
  } else if (window.modelCalling && !window.hasProbe) {
    suggestion = 'add_probe';
  } else if (window.noChange / Math.max(1, window.runs) > 0.8) {
    suggestion = 'slow_down';
    estSaving = window.cost * 0.5;
  } else if (window.runs > 0 && usefulRunRate < 0.1 && window.neededHuman > 0) {
    suggestion = 'event_trigger';
    estSaving = window.cost * 0.3;
  }
  return {
    ...window,
    costPerUsefulRun,
    usefulRunRate,
    suggestion,
    ...(estSaving !== undefined ? { estSaving } : {}),
    daysSinceUseful,
  };
}
