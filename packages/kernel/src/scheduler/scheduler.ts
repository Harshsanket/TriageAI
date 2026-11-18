/**
 * Kernel scheduler (18.T4): recurring jobs are durable scheduled workflows,
 * not module timers. At boot it reads every registered workflow whose trigger
 * is `schedule`, starts it on its cron cadence with one deterministic
 * idempotency key per time bucket, and records state/history for routine
 * receipts (18.T33, 19.T8).
 *
 * Routine rules enforced here:
 *   - probe first: a declared watermark probe is read deterministically; an
 *     unchanged value ends the occurrence as `no_change` with no run.
 *   - watermark advances only after a run finishes successfully, so a crashed
 *     or failed run is retried on the next occurrence.
 *   - overlap: a still PENDING/RUNNING occurrence is skipped and recorded;
 *     work is never queued behind it.
 *   - fresh context: scheduled runs are persisted with `trigger = 'schedule'`
 *     and carry a `__schedule` input envelope. The context packer hook is
 *     documented in docs/contracts (history is unavailable for this trigger).
 *   - silentWhenEmpty: the flag travels on the run envelope/state; modules
 *     still own output delivery and must not send when the result is empty.
 */
import { ulid } from 'ulid';

import { AppError, invalid, notFound } from '../errors.js';
import { graphCallsModels } from '../evals/ladder.js';
import type { WorkflowGraph } from '../graph/v2.js';
import { canonicalJson } from '../mp1/jcs.js';
import type { Database, KernelLogger, WorkflowDef } from '../types.js';
import type { WorkflowEngine } from '../workflow.js';

import { cronIntervalMinutes, nextCronOccurrence, parseCron } from './cron.js';
import type { CronSpec } from './cron.js';
import { readProbeWatermark, watermarkValue } from './probe.js';
import type { ProbeReader } from './probe.js';

const FINAL_RUN_STATUS = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING']);
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_RUN_POLL_MS = 1_000;
const DEFAULT_MAX_RUN_WAIT_MS = 30 * 60_000;
const USEFUL_MARKERS = new Set([
  'sent',
  'waiting',
  'completed',
  'artifacts',
  'stateChanges',
  'created',
  'updated',
  'delivered',
  'wrote',
  'emitted',
  'flushed',
  'outputs',
]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ScheduleDefinition {
  id: string;
  workflowId: string;
  module: string;
  cron: string;
  spec: CronSpec;
  probe?: { kind: 'watermark'; read: string };
  overlap: 'skip';
  silentWhenEmpty: boolean;
  intervalMinutes: number;
  modelCalling: boolean;
  /** Declared `trigger.config.input`, if any. */
  input?: unknown;
}

export interface ScheduleSnapshot {
  id: string;
  workflowId: string;
  module: string;
  cron: string;
  probe?: { kind: 'watermark'; read: string };
  overlap: 'skip';
  silentWhenEmpty: boolean;
  intervalMinutes: number;
  modelCalling: boolean;
  nextRunAt: string | null;
}

export interface ScheduleStateRow {
  scheduleId: string;
  workflowId: string;
  watermark: unknown;
  lastRunAt: string | null;
  lastStatus: string | null;
  skippedOverlap: number;
  updatedAt: string | null;
}

export interface ScheduleRunRow {
  id: string;
  scheduleId: string;
  workflowId: string;
  runId: string | null;
  dueAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: string;
  manual: boolean;
  useful: boolean;
  neededHuman: boolean;
  outputEmpty: boolean;
  cost: number;
  watermarkAfter: unknown;
}

export type ScheduleStarter = (
  workflowId: string,
  input: unknown,
  opts?: {
    idempotencyKey?: string;
    trigger?: string;
    orgId?: string | null;
    ownerId?: string | null;
  },
) => Promise<{ runId: string; deduped: boolean }>;

export interface SchedulerOptions {
  database: Database;
  engine: WorkflowEngine;
  startWorkflow: ScheduleStarter;
  logger: KernelLogger;
  now?: () => Date;
  pollIntervalMs?: number;
  runPollMs?: number;
  maxRunWaitMs?: number;
  probeReaders?: Record<string, ProbeReader>;
}

interface ManagedSchedule extends ScheduleDefinition {
  nextRunAt: Date;
}

interface RunStatusRow extends Record<string, unknown> {
  status: string;
  output: unknown;
}

export function cronForInterval(minutes: number): string | null {
  if (!Number.isInteger(minutes) || minutes < 1) return null;
  if (minutes === 60) return '0 * * * *';
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  if (minutes > 60 && minutes % 60 === 0 && minutes <= 1440) return `0 */${minutes / 60} * * *`;
  return null;
}

/** True when the run output contains an artifact/state change/sent/waiting item. */
function markerHasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim().length > 0;
  return value != null;
}

export function runOutputUseful(output: unknown, depth = 0): boolean {
  if (output == null || depth > 4) return false;
  if (Array.isArray(output)) return output.length > 0;
  if (typeof output !== 'object') return markerHasValue(output);
  const record = output as Record<string, unknown>;
  if (record.useful === true) return true;
  for (const [key, value] of Object.entries(record)) {
    if (USEFUL_MARKERS.has(key) && markerHasValue(value)) return true;
    if (value && typeof value === 'object' && runOutputUseful(value, depth + 1)) return true;
  }
  return false;
}

export function outputIsEmpty(output: unknown, depth = 0): boolean {
  if (output == null || depth > 4) return true;
  if (typeof output === 'string') return output.trim().length === 0;
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output !== 'object') return false;
  const values = Object.values(output as Record<string, unknown>);
  return values.length === 0 || values.every((value) => outputIsEmpty(value, depth + 1));
}

function sameWatermark(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left ?? null) === canonicalJson(right ?? null);
  } catch {
    return left === right;
  }
}

function scheduleTriggerOf(def: WorkflowDef, graph?: WorkflowGraph): WorkflowGraph['trigger'] {
  if (graph?.trigger?.type === 'schedule') return graph.trigger;
  return def.trigger;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function probeFrom(value: unknown): { kind: 'watermark'; read: string } | undefined {
  const record = asRecord(value);
  if (record.kind === 'watermark' && typeof record.read === 'string' && record.read.trim()) {
    return { kind: 'watermark', read: record.read };
  }
  return undefined;
}

export class Scheduler {
  private schedules = new Map<string, ManagedSchedule>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private tickInFlight: Promise<void> | null = null;
  private watchers = new Set<Promise<void>>();

  private readonly database: Database;
  private readonly engine: WorkflowEngine;
  private readonly startWorkflow: ScheduleStarter;
  private readonly logger: KernelLogger;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly runPollMs: number;
  private readonly maxRunWaitMs: number;
  private readonly probeReaders: Record<string, ProbeReader>;

  constructor(options: SchedulerOptions) {
    this.database = options.database;
    this.engine = options.engine;
    this.startWorkflow = options.startWorkflow;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.runPollMs = options.runPollMs ?? DEFAULT_RUN_POLL_MS;
    this.maxRunWaitMs = options.maxRunWaitMs ?? DEFAULT_MAX_RUN_WAIT_MS;
    this.probeReaders = options.probeReaders ?? {};
  }

  /** Load (or reload) registered schedules and start the ticker. Idempotent. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.load();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick().catch((err: unknown) =>
          this.logger.error({ err: (err as Error).message }, 'scheduler tick failed'),
        );
      }, this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Stop claiming new occurrences; in-flight workflow runs are not cancelled. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const tick = this.tickInFlight;
    if (tick) await tick.catch(() => undefined);
  }

  /** Wait for background run watchers (tests and graceful shutdown checks). */
  async waitForIdle(): Promise<void> {
    while (this.watchers.size > 0) {
      await Promise.allSettled([...this.watchers]);
    }
  }

  snapshot(): ScheduleSnapshot[] {
    return [...this.schedules.values()]
      .map((schedule) => ({
        id: schedule.id,
        workflowId: schedule.workflowId,
        module: schedule.module,
        cron: schedule.cron,
        ...(schedule.probe ? { probe: schedule.probe } : {}),
        overlap: schedule.overlap,
        silentWhenEmpty: schedule.silentWhenEmpty,
        intervalMinutes: schedule.intervalMinutes,
        modelCalling: schedule.modelCalling,
        nextRunAt: schedule.nextRunAt.toISOString(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async state(scheduleId: string): Promise<ScheduleStateRow | undefined> {
    const rows = await this.database.query<{
      schedule_id: string;
      workflow_id: string;
      watermark: unknown;
      last_run_at: string | null;
      last_status: string | null;
      skipped_overlap: number;
      updated_at: string | null;
    }>(
      `SELECT schedule_id, workflow_id, watermark, last_run_at, last_status,
              skipped_overlap, updated_at
         FROM schedule_state WHERE schedule_id = $1`,
      [scheduleId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      scheduleId: row.schedule_id,
      workflowId: row.workflow_id,
      watermark: row.watermark,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      skippedOverlap: Number(row.skipped_overlap),
      updatedAt: row.updated_at,
    };
  }

  /**
   * Manual "run now" (18.T33): always a new run, marked `trigger.manual` and
   * counted separately in the receipt. It does not consume the cron slot.
   */
  async runNow(
    scheduleId: string,
    opts: { actor?: string | null } = {},
  ): Promise<{ runId: string; deduped: boolean }> {
    const managed = this.schedules.get(scheduleId);
    const def = this.engine.get(scheduleId);
    if (!managed && !def) throw notFound(`unknown schedule ${scheduleId}`);
    if (!managed && def && scheduleTriggerOf(def.def, def.def.graph).type !== 'schedule') {
      throw invalid(`${scheduleId} is not a schedule workflow`);
    }
    const workflowId = managed?.workflowId ?? scheduleId;
    const silentWhenEmpty = managed?.silentWhenEmpty ?? true;
    const input = {
      ...asRecord(managed?.input),
      __schedule: {
        id: scheduleId,
        trigger: 'manual',
        silentWhenEmpty,
        actor: opts.actor ?? null,
      },
    };
    const started = await this.startWorkflow(workflowId, input, {
      idempotencyKey: `manual:${scheduleId}:${ulid()}`,
      trigger: 'manual',
    });
    await this.database.query(
      `INSERT INTO schedule_runs
         (id, schedule_id, workflow_id, run_id, started_at, outcome, manual)
       VALUES ($1, $2, $3, $4, now(), 'started', true)`,
      [ulid(), scheduleId, workflowId, started.runId],
    );
    await this.upsertState(scheduleId, workflowId, { lastStatus: 'manual_running' });
    this.watch(scheduleId, started.runId, true);
    return started;
  }

  /** One scheduler cycle; public so tests can drive a deterministic clock. */
  async tick(now: Date = this.now()): Promise<void> {
    if (this.stopped) return;
    if (this.tickInFlight) return this.tickInFlight;
    const task = this.runTick(now)
      .catch((err: unknown) => {
        this.logger.error({ err: (err as Error).message }, 'scheduler tick failed');
      })
      .finally(() => {
        this.tickInFlight = null;
      });
    this.tickInFlight = task;
    return task;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async runTick(now: Date): Promise<void> {
    for (const schedule of this.schedules.values()) {
      try {
        await this.reconcile(schedule.id);
        if (now.getTime() < schedule.nextRunAt.getTime()) continue;
        const due = schedule.nextRunAt;
        // Never backfill a storm after downtime: the next slot is computed
        // from the current clock, not from every missed minute. Advance only
        // after the occurrence is recorded, so a transient failure retries.
        const next = nextCronOccurrence(schedule.spec, now.getTime() > due.getTime() ? now : due);
        await this.fire(schedule, due, now);
        schedule.nextRunAt = next;
      } catch (err) {
        this.logger.error(
          { schedule: schedule.id, err: (err as Error).message },
          'scheduled occurrence failed',
        );
      }
    }
  }

  private async load(): Promise<void> {
    this.schedules.clear();
    for (const registered of this.engine.list()) {
      const def = registered.def;
      const graph = def.graph ?? this.engine.graphFor(def.id, def.version);
      const trigger = scheduleTriggerOf(def, graph);
      if (trigger.type !== 'schedule') continue;
      const config = {
        ...asRecord(def.trigger.config),
        ...asRecord(trigger.config),
      };
      const declaredCron =
        trigger.schedule?.cron ?? (typeof config.cron === 'string' ? config.cron : undefined);
      const configuredInterval =
        typeof config.intervalMinutes === 'number' && config.intervalMinutes > 0
          ? config.intervalMinutes
          : undefined;
      const cron =
        declaredCron ?? (configuredInterval ? cronForInterval(configuredInterval) : null);
      if (!cron) {
        this.logger.info(
          { workflow: def.id },
          'schedule workflow has no cron/interval; the kernel scheduler does not manage it',
        );
        continue;
      }
      let spec: CronSpec;
      try {
        spec = parseCron(cron);
      } catch (err) {
        throw new AppError(
          'kernel.WORKFLOW_INVALID',
          `schedule ${def.id}: ${(err as Error).message}`,
          undefined,
          422,
          {
            category: 'validation',
            retryable: false,
            userMessage:
              'A scheduled workflow has an invalid cron expression; check the boot logs.',
          },
        );
      }
      const intervalMinutes = configuredInterval ?? cronIntervalMinutes(spec, this.now());
      const probe = trigger.schedule?.probe ?? probeFrom(config.probe) ?? undefined;
      const managed: ManagedSchedule = {
        id: def.id,
        workflowId: def.id,
        module: def.module,
        cron,
        spec,
        ...(probe ? { probe } : {}),
        overlap: 'skip',
        silentWhenEmpty: trigger.schedule?.silentWhenEmpty ?? config.silentWhenEmpty !== false,
        intervalMinutes,
        modelCalling: graph ? graphCallsModels(graph) : false,
        ...(config.input !== undefined ? { input: config.input } : {}),
        nextRunAt: nextCronOccurrence(spec, this.now()),
      };
      this.schedules.set(managed.id, managed);
      await this.upsertState(managed.id, managed.workflowId);
    }
  }

  private async upsertState(
    scheduleId: string,
    workflowId: string,
    patch: { lastStatus?: string } = {},
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO schedule_state (schedule_id, workflow_id, last_status)
       VALUES ($1, $2, $3)
       ON CONFLICT (schedule_id) DO UPDATE SET
         workflow_id = EXCLUDED.workflow_id,
         last_status = COALESCE($3, schedule_state.last_status),
         updated_at = now()`,
      [scheduleId, workflowId, patch.lastStatus ?? null],
    );
  }

  private async fire(schedule: ManagedSchedule, due: Date, now: Date): Promise<void> {
    const overlap = await this.database.query<{ id: string }>(
      `SELECT id FROM workflow_runs
        WHERE workflow_id = $1 AND status IN ('PENDING','RUNNING')
        LIMIT 1`,
      [schedule.workflowId],
    );
    if (overlap[0]) {
      await this.recordNonRun(schedule, due, 'skipped_overlap', true);
      this.logger.warn(
        { schedule: schedule.id, running: overlap[0].id },
        'scheduled occurrence skipped: previous run still active',
      );
      return;
    }

    const state = await this.state(schedule.id);
    let probeOk = false;
    let probeValue: unknown;
    if (schedule.probe) {
      try {
        probeValue = await readProbeWatermark(
          this.database,
          schedule.probe.read,
          this.probeReaders,
        );
        probeOk = true;
      } catch (err) {
        // Fail open: a broken probe must not stall the routine forever. No
        // watermark is persisted for this occurrence, so the next one retries.
        this.logger.warn(
          { schedule: schedule.id, read: schedule.probe.read, err: (err as Error).message },
          'probe read failed; running the occurrence without a watermark',
        );
      }
      if (probeOk && sameWatermark(probeValue, watermarkValue(state?.watermark))) {
        await this.recordNonRun(schedule, due, 'no_change', true, {
          probe: schedule.probe.read,
          watermark: probeValue ?? null,
        });
        return;
      }
    }

    const input = {
      ...asRecord(schedule.input),
      __schedule: {
        id: schedule.id,
        trigger: 'schedule',
        silentWhenEmpty: schedule.silentWhenEmpty,
        probe: schedule.probe?.read ?? null,
      },
    };
    const started = await this.startWorkflow(schedule.workflowId, input, {
      idempotencyKey: `schedule:${schedule.id}:${due.toISOString()}`,
      trigger: 'schedule',
    });
    if (started.deduped) {
      await this.database.query(
        `UPDATE schedule_state SET last_run_at = $2, last_status = 'deduped', updated_at = now()
          WHERE schedule_id = $1`,
        [schedule.id, now.toISOString()],
      );
      return;
    }
    await this.database.query(
      `INSERT INTO schedule_runs
         (id, schedule_id, workflow_id, run_id, due_at, started_at, outcome,
          manual, watermark_after)
       VALUES ($1, $2, $3, $4, $5, now(), 'started', false, $6)
       ON CONFLICT DO NOTHING`,
      [
        ulid(),
        schedule.id,
        schedule.workflowId,
        started.runId,
        due.toISOString(),
        probeOk ? { value: probeValue ?? null } : null,
      ],
    );
    await this.database.query(
      `UPDATE schedule_state SET last_run_at = $2, last_status = 'running', updated_at = now()
        WHERE schedule_id = $1`,
      [schedule.id, now.toISOString()],
    );
    this.watch(schedule.id, started.runId, false);
  }

  private async recordNonRun(
    schedule: ManagedSchedule,
    due: Date,
    outcome: 'no_change' | 'skipped_overlap',
    outputEmpty: boolean,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO schedule_runs
         (id, schedule_id, workflow_id, due_at, started_at, finished_at, outcome,
          manual, output_empty, detail)
       VALUES ($1, $2, $3, $4, now(), now(), $5, false, $6, $7)
       ON CONFLICT DO NOTHING`,
      [ulid(), schedule.id, schedule.workflowId, due.toISOString(), outcome, outputEmpty, detail],
    );
    await this.database.query(
      `UPDATE schedule_state SET
         last_run_at = now(),
         last_status = $2,
         skipped_overlap = skipped_overlap + $3,
         updated_at = now()
       WHERE schedule_id = $1`,
      [schedule.id, outcome, outcome === 'skipped_overlap' ? 1 : 0],
    );
  }

  private watch(scheduleId: string, runId: string, manual: boolean): void {
    const task = this.pollRun(scheduleId, runId, manual).catch((err: unknown) => {
      this.logger.warn(
        { schedule: scheduleId, runId, err: (err as Error).message },
        'scheduler run watcher failed',
      );
    });
    this.watchers.add(task);
    task.finally(() => this.watchers.delete(task)).catch(() => undefined);
  }

  private async pollRun(scheduleId: string, runId: string, manual: boolean): Promise<void> {
    const deadline = Date.now() + this.maxRunWaitMs;
    for (;;) {
      const rows = await this.database.query<RunStatusRow>(
        `SELECT status, output FROM workflow_runs WHERE id = $1`,
        [runId],
      );
      const run = rows[0];
      if (!run) return;
      if (FINAL_RUN_STATUS.has(run.status)) {
        await this.finalize(scheduleId, runId, manual, run);
        return;
      }
      if (Date.now() >= deadline) return;
      await sleep(this.runPollMs);
    }
  }

  /** Recover occurrences whose watcher died (process restart) or timed out. */
  private async reconcile(scheduleId: string): Promise<void> {
    const rows = await this.database.query<{ id: string; run_id: string; manual: boolean }>(
      `SELECT id, run_id, manual FROM schedule_runs
        WHERE schedule_id = $1 AND outcome = 'started' AND run_id IS NOT NULL
        ORDER BY started_at DESC LIMIT 10`,
      [scheduleId],
    );
    for (const row of rows) {
      const runs = await this.database.query<RunStatusRow>(
        `SELECT status, output FROM workflow_runs WHERE id = $1`,
        [row.run_id],
      );
      const run = runs[0];
      if (run && FINAL_RUN_STATUS.has(run.status)) {
        await this.finalize(scheduleId, row.run_id, row.manual, run);
      }
    }
  }

  private async finalize(
    scheduleId: string,
    runId: string,
    manual: boolean,
    run: RunStatusRow,
  ): Promise<void> {
    const outputEmpty = outputIsEmpty(run.output);
    const useful =
      run.status === 'AWAITING' || (run.status === 'SUCCEEDED' && runOutputUseful(run.output));
    const neededHuman = run.status === 'AWAITING';
    const outcome =
      run.status === 'FAILED'
        ? 'failed'
        : run.status === 'CANCELLED'
          ? 'cancelled'
          : run.status === 'AWAITING'
            ? 'needs_human'
            : outputEmpty
              ? 'empty'
              : 'succeeded';
    const costRows = await this.database.query<{ cost: number }>(
      `SELECT COALESCE(SUM(COALESCE(actual_cost, est_cost)), 0)::float AS cost
         FROM cost_ledger WHERE run_id = $1`,
      [runId],
    );
    await this.database.query(
      `UPDATE schedule_runs SET
         outcome = $2, useful = $3, needed_human = $4, output_empty = $5,
         cost = $6, finished_at = now()
       WHERE run_id = $1 AND outcome = 'started'`,
      [runId, outcome, useful, neededHuman, outputEmpty, Number(costRows[0]?.cost ?? 0)],
    );
    if (manual) {
      // A manual run never moves the watermark or clobbers a scheduled status.
      await this.database.query(
        `UPDATE schedule_state SET last_status = $2, updated_at = now()
          WHERE schedule_id = $1 AND last_status = 'manual_running'`,
        [scheduleId, `manual_${outcome}`],
      );
      return;
    }

    const history = await this.database.query<{ watermark_after: unknown }>(
      `SELECT watermark_after FROM schedule_runs WHERE run_id = $1 AND manual = false LIMIT 1`,
      [runId],
    );
    const watermarkAfter = history[0]?.watermark_after;
    await this.database.query(
      `UPDATE schedule_state SET last_status = $2, updated_at = now() WHERE schedule_id = $1`,
      [scheduleId, outcome],
    );
    if (watermarkAfter != null && (run.status === 'SUCCEEDED' || run.status === 'AWAITING')) {
      await this.database.query(
        `UPDATE schedule_state SET watermark = $2, updated_at = now() WHERE schedule_id = $1`,
        [scheduleId, watermarkAfter],
      );
    }
  }
}
