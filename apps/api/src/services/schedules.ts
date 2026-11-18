/**
 * Schedules read model for `/config` → Schedules (19.T8). The kernel scheduler
 * owns execution/state; this service joins it with `schedule_runs` history and
 * computes the routine receipt/suggestion. Suggestions are advisory only: the
 * accept endpoint writes a settings row, never a schedule change.
 */
import {
  graphCallsModels,
  invalid,
  notFound,
  routineReceipt,
  type Kernel,
  type RoutineReceipt,
  type WorkflowGraph,
} from '@triageai/kernel';

export const SCHEDULE_SUGGESTIONS = [
  'keep',
  'slow_down',
  'event_trigger',
  'add_probe',
  'retire',
] as const;
export type ScheduleSuggestion = (typeof SCHEDULE_SUGGESTIONS)[number];

const SUGGESTIONS_KEY = 'schedules.suggestions';
const DEFAULT_DAYS = 30;

export interface AcceptedSuggestion {
  suggestion: ScheduleSuggestion;
  acceptedAt: string;
  by: string | null;
  days: number;
}

export interface ScheduleView {
  id: string;
  workflowId: string;
  module: string;
  cron: string | null;
  probe: { kind: 'watermark'; read: string } | null;
  overlap: 'skip';
  silentWhenEmpty: boolean;
  intervalMinutes: number | null;
  modelCalling: boolean;
  managed: boolean;
  nextRunAt: string | null;
  state: {
    watermark: unknown;
    lastRunAt: string | null;
    lastStatus: string | null;
    skippedOverlap: number;
    updatedAt: string | null;
  } | null;
  receipt: RoutineReceipt & { scheduleId: string; window: { from: string; to: string } };
  acceptedSuggestion: AcceptedSuggestion | null;
}

interface ReceiptRow extends Record<string, unknown> {
  runs: number;
  no_change: number;
  useful: number;
  needed_human: number;
  repeated_failures: number;
  skipped_overlap: number;
  manual_runs: number;
  cost: number;
  last_useful_at: string | null;
}

async function readAcceptedMap(kernel: Kernel): Promise<Record<string, AcceptedSuggestion>> {
  const rows = await kernel.database
    .query<{ value: Record<string, AcceptedSuggestion> }>(
      `SELECT value FROM settings WHERE key = $1`,
      [SUGGESTIONS_KEY],
    )
    .catch(() => []);
  const stored = rows[0]?.value;
  return stored && typeof stored === 'object' ? stored : {};
}

function isSuggestion(value: string): value is ScheduleSuggestion {
  return (SCHEDULE_SUGGESTIONS as readonly string[]).includes(value);
}

function receiptRow(row: ReceiptRow | undefined) {
  return {
    runs: Number(row?.runs ?? 0),
    noChange: Number(row?.no_change ?? 0),
    useful: Number(row?.useful ?? 0),
    neededHuman: Number(row?.needed_human ?? 0),
    repeatedFailures: Number(row?.repeated_failures ?? 0),
    skippedOverlap: Number(row?.skipped_overlap ?? 0),
    manualRuns: Number(row?.manual_runs ?? 0),
    cost: Number(row?.cost ?? 0),
    lastUsefulAt: row?.last_useful_at ?? null,
  };
}

async function computeReceipt(
  kernel: Kernel,
  scheduleId: string,
  days: number,
  meta: { hasProbe: boolean; intervalMinutes?: number | null; modelCalling: boolean },
  now = new Date(),
): Promise<RoutineReceipt & { scheduleId: string; window: { from: string; to: string } }> {
  const from = new Date(now.getTime() - days * 86_400_000);
  const rows = await kernel.database.query<ReceiptRow>(
    `SELECT
       COUNT(*) FILTER (
         WHERE manual = false
           AND outcome IN ('started','succeeded','empty','needs_human','failed','cancelled')
       )::int AS runs,
       COUNT(*) FILTER (WHERE manual = false AND outcome = 'no_change')::int AS no_change,
       COUNT(*) FILTER (WHERE manual = false AND useful)::int AS useful,
       COUNT(*) FILTER (WHERE manual = false AND needed_human)::int AS needed_human,
       COUNT(*) FILTER (WHERE manual = false AND outcome = 'failed')::int AS repeated_failures,
       COUNT(*) FILTER (WHERE manual = false AND outcome = 'skipped_overlap')::int AS skipped_overlap,
       COUNT(*) FILTER (WHERE manual = true)::int AS manual_runs,
       COALESCE(SUM(cost) FILTER (WHERE manual = false), 0)::float AS cost,
       MAX(started_at) FILTER (WHERE manual = false AND useful) AS last_useful_at
     FROM schedule_runs
     WHERE schedule_id = $1 AND started_at >= $2`,
    [scheduleId, from.toISOString()],
  );
  const window = receiptRow(rows[0]);
  return {
    scheduleId,
    window: { from: from.toISOString(), to: now.toISOString() },
    ...routineReceipt(
      {
        ...window,
        hasProbe: meta.hasProbe,
        ...(meta.intervalMinutes != null ? { intervalMinutes: meta.intervalMinutes } : {}),
        modelCalling: meta.modelCalling,
      },
      now,
    ),
  };
}

/**
 * Every registered schedule workflow. A workflow whose trigger is `schedule`
 * but has no cron (a module-owned timer that has not migrated yet) is listed
 * as `managed: false` so it is visible and can be run manually.
 */
function callsModels(
  kernel: Kernel,
  workflow: { def: { id: string; version: string; graph?: WorkflowGraph } },
): boolean {
  const graph =
    workflow.def.graph ?? kernel.workflowEngine.graphFor(workflow.def.id, workflow.def.version);
  return graph ? graphCallsModels(graph) : false;
}

export async function listSchedules(kernel: Kernel, days = DEFAULT_DAYS): Promise<ScheduleView[]> {
  const snapshots = new Map(kernel.scheduler.snapshot().map((snapshot) => [snapshot.id, snapshot]));
  const accepted = await readAcceptedMap(kernel);
  const workflows = kernel.workflowEngine.list().filter((workflow) => {
    const trigger = workflow.def.graph?.trigger ?? workflow.def.trigger;
    return trigger.type === 'schedule';
  });
  const views: ScheduleView[] = [];
  for (const workflow of workflows) {
    const snapshot = snapshots.get(workflow.def.id);
    const state = await kernel.scheduler.state(workflow.def.id);
    const meta = {
      hasProbe: Boolean(snapshot?.probe),
      intervalMinutes: snapshot?.intervalMinutes ?? null,
      modelCalling: snapshot?.modelCalling ?? callsModels(kernel, workflow),
    };
    views.push({
      id: workflow.def.id,
      workflowId: workflow.def.id,
      module: workflow.def.module,
      cron: snapshot?.cron ?? null,
      probe: snapshot?.probe ?? null,
      overlap: 'skip',
      silentWhenEmpty: snapshot?.silentWhenEmpty ?? true,
      intervalMinutes: meta.intervalMinutes,
      modelCalling: meta.modelCalling,
      managed: Boolean(snapshot),
      nextRunAt: snapshot?.nextRunAt ?? null,
      state: state
        ? {
            watermark: state.watermark,
            lastRunAt: state.lastRunAt,
            lastStatus: state.lastStatus,
            skippedOverlap: state.skippedOverlap,
            updatedAt: state.updatedAt,
          }
        : null,
      receipt: await computeReceipt(kernel, workflow.def.id, days, meta),
      acceptedSuggestion: accepted[workflow.def.id] ?? null,
    });
  }
  return views.sort((left, right) => left.id.localeCompare(right.id));
}

export async function readScheduleReceipt(
  kernel: Kernel,
  scheduleId: string,
  days = DEFAULT_DAYS,
): Promise<RoutineReceipt & { scheduleId: string; window: { from: string; to: string } }> {
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw invalid('days must be an integer between 1 and 365');
  }
  const workflow = kernel.workflowEngine.get(scheduleId);
  if (!workflow) throw notFound(`unknown schedule ${scheduleId}`);
  const trigger = workflow.def.graph?.trigger ?? workflow.def.trigger;
  if (trigger.type !== 'schedule') throw notFound(`unknown schedule ${scheduleId}`);
  const snapshot = kernel.scheduler.snapshot().find((entry) => entry.id === scheduleId);
  return computeReceipt(kernel, scheduleId, days, {
    hasProbe: Boolean(snapshot?.probe),
    intervalMinutes: snapshot?.intervalMinutes ?? null,
    modelCalling: snapshot?.modelCalling ?? callsModels(kernel, workflow),
  });
}

export async function acceptScheduleSuggestion(
  kernel: Kernel,
  scheduleId: string,
  suggestion: string,
  actor: string | null,
  days = DEFAULT_DAYS,
): Promise<AcceptedSuggestion> {
  if (!isSuggestion(suggestion)) {
    throw invalid(`suggestion must be one of ${SCHEDULE_SUGGESTIONS.join(', ')}`);
  }
  const workflow = kernel.workflowEngine.get(scheduleId);
  if (!workflow) throw notFound(`unknown schedule ${scheduleId}`);
  const trigger = workflow.def.graph?.trigger ?? workflow.def.trigger;
  if (trigger.type !== 'schedule') throw notFound(`unknown schedule ${scheduleId}`);
  const accepted: AcceptedSuggestion = {
    suggestion,
    acceptedAt: new Date().toISOString(),
    by: actor,
    days,
  };
  const current = await readAcceptedMap(kernel);
  const next = { ...current, [scheduleId]: accepted };
  await kernel.database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [SUGGESTIONS_KEY, next, actor ?? 'system'],
  );
  return accepted;
}
