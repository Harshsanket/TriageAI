/** Run receipts, reversibility and per-flow autonomy (Phase 15.T8–T10). */
export type UndoClass = 'free' | 'compensable' | 'none';
export type AutonomyLevel = 'investigate' | 'draft' | 'internal_note' | 'autopilot';

export interface ToolCallRecord {
  tool: string;
  undo: UndoClass;
  status: 'ok' | 'error' | 'blocked';
}

export interface RunReceipt {
  runId: string;
  completed: Array<{ tool: string; count: number }>;
  sent: Array<{ tool: string; count: number }>;
  waiting: Array<{
    approvalId: string;
    tool: string;
    count: number;
    summary: string;
    parked: boolean;
  }>;
  useful: boolean;
}

export function buildRunReceipt(args: {
  runId: string;
  calls: ToolCallRecord[];
  waiting?: RunReceipt['waiting'];
}): RunReceipt {
  const completed = new Map<string, number>();
  const sent = new Map<string, number>();
  for (const call of args.calls) {
    if (call.status !== 'ok') continue;
    const bucket = call.undo === 'none' ? sent : completed;
    bucket.set(call.tool, (bucket.get(call.tool) ?? 0) + 1);
  }
  const waiting = args.waiting ?? [];
  return {
    runId: args.runId,
    completed: [...completed].map(([tool, count]) => ({ tool, count })),
    sent: [...sent].map(([tool, count]) => ({ tool, count })),
    waiting,
    useful: completed.size > 0 || sent.size > 0 || waiting.length > 0,
  };
}

/** Finish reversible work; park at the first irreversible call. */
export function firstIrreversiblePark(
  calls: Array<{ tool: string; undo: UndoClass }>,
): { parkAt: number } | null {
  const index = calls.findIndex((call) => call.undo === 'none');
  return index >= 0 ? { parkAt: index } : null;
}

export interface FlowAutonomyState {
  level: AutonomyLevel;
  cleanRunStreak: number;
  promoteAfter: number;
}

export function nextAutonomy(
  state: FlowAutonomyState,
  event: { clean: boolean; targetProduction?: boolean },
): { level: AutonomyLevel; cleanRunStreak: number; changed: boolean; reason: string } {
  const levels: AutonomyLevel[] = ['investigate', 'draft', 'internal_note', 'autopilot'];
  if (!event.clean) {
    const current = levels.indexOf(state.level);
    const next = levels[Math.max(0, current - 1)] as AutonomyLevel;
    return {
      level: next,
      cleanRunStreak: 0,
      changed: next !== state.level,
      reason: 'dirty_run_demotion',
    };
  }
  if (event.targetProduction && state.level === 'autopilot') {
    return { level: 'draft', cleanRunStreak: 0, changed: true, reason: 'production_target' };
  }
  const streak = state.cleanRunStreak + 1;
  return {
    level: state.level,
    cleanRunStreak: streak,
    changed: false,
    reason: streak >= state.promoteAfter ? 'promotion_suggested' : 'streak',
  };
}

export interface AgentJob {
  role: string;
  inputs: string;
  output: string;
  doneWhen: string;
  domain: string;
}

export function validateAgentDefinition(args: {
  id: string;
  displayName: string;
  job?: Partial<AgentJob>;
  agentReason?: string[];
  teamSize?: number;
}): string[] {
  const problems: string[] = [];
  if (!args.id.trim()) problems.push('id is required');
  if (args.displayName.trim().length < 1 || args.displayName.trim().length > 40) {
    problems.push('displayName must be 1–40 characters');
  }
  for (const field of ['role', 'inputs', 'output', 'doneWhen', 'domain'] as const) {
    if (!args.job?.[field]?.trim()) problems.push(`job.${field} is required`);
  }
  if (!args.agentReason?.length) {
    problems.push('agentReason is required (or make it a skill instead)');
  }
  if ((args.teamSize ?? 0) > 6) problems.push('a team holds at most 6 agents');
  return problems;
}

export interface RoutineValidation {
  cron: string;
  probe?: { kind: 'watermark'; read: string };
  overlap?: 'skip';
  modelCalling?: boolean;
  intervalMinutes?: number;
  eventKind?: string;
  when?: string;
}

export function validateRoutine(input: RoutineValidation): string[] {
  const problems: string[] = [];
  if (input.modelCalling && (input.intervalMinutes ?? 60) < 60 && !input.probe) {
    problems.push('sub-hourly model-calling schedules require a probe');
  }
  if (input.probe && input.probe.kind !== 'watermark') problems.push('probe must be a watermark');
  if (input.eventKind && !input.when?.trim()) {
    problems.push('event triggers need a filter narrower than the event kind');
  }
  return problems;
}

export function archiveCutoff(
  now = new Date(),
  activeDays = 180,
  deleteDays = 365,
): { archiveBefore: string; deleteBefore: string } {
  const archive = new Date(now);
  archive.setUTCDate(archive.getUTCDate() - activeDays);
  const remove = new Date(now);
  remove.setUTCDate(remove.getUTCDate() - deleteDays);
  return { archiveBefore: archive.toISOString(), deleteBefore: remove.toISOString() };
}
