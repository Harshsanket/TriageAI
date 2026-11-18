/**
 * Nightly regression, drift and opt-in auto-rollback (Phase 18.1/18.T2).
 *
 * The host owns the timer (app.ts, once per day, unref'd, never in tests). This
 * service reads recent merged eval reports, keeps a rolling baseline in
 * `settings` under `evals.baselines`, raises a drift alert, and — only when
 * `evals.autoRollback` is true — rolls the active model back to the previous
 * passing asset through the existing registry rollback. A rollback that cannot
 * run is recorded as an audited alert instead of failing silently.
 */
import { detectDrift, readSetting, rollingBaseline, shouldAutoRollback } from '@triageai/kernel';
import type { Database, DriftResult, RollingBaseline } from '@triageai/kernel';

import { writeAudit } from './audit.js';
import { rollbackActiveModel } from './modelRegistry.js';

export const EVAL_BASELINES_KEY = 'evals.baselines';
export const EVAL_AUTO_ROLLBACK_KEY = 'evals.autoRollback';
export const EVAL_SCORE_FLOOR_KEY = 'evals.scoreFloor';
export const DEFAULT_EVAL_SCORE_FLOOR = 0.8;
export const EVAL_ROLLBACK_WINDOWS = 3;
export const EVAL_BASELINE_WINDOW = 30;

/** Canonical 0–1 quality metrics, most specific first. */
const QUALITY_METRICS = [
  'groundedness',
  'macroF1',
  'recallAt3',
  'mrr',
  'citationCoverage',
  'taskSuccess',
  'stepAccuracy',
] as const;

interface EvalReportRow {
  [key: string]: unknown;
  id: string;
  subject_model_id: string | null;
  metrics: Record<string, unknown> | null;
  passes: boolean;
  generated_at: Date | string;
}

export interface StoredBaselines {
  scores: number[];
  reportIds: string[];
  /** Latest rolling baseline (scores before the newest report). */
  baseline: RollingBaseline | null;
  updatedAt: string | null;
}

export interface RollbackOutcome {
  rolledBackTo: string;
}

export type RollbackFn = (args: {
  component: string;
  modelId: string | null;
  reason: string;
}) => Promise<RollbackOutcome | null>;

export interface NightlyEvalDeps {
  database: Database;
  /** Registry used by the default rollback; tests inject `rollback` instead. */
  registry?: { invalidate?: () => void };
  /** Test seam / alternate registry rollback implementation. */
  rollback?: RollbackFn;
  now?: Date;
  baselineWindow?: number;
  floor?: number;
}

export interface NightlyEvalResult {
  reports: number;
  newReports: number;
  currentScore: number | null;
  baseline: RollingBaseline | null;
  drift: DriftResult;
  rollbackDue: boolean;
  autoRollbackEnabled: boolean;
  rollback: {
    attempted: boolean;
    performed: boolean;
    rolledBackTo: string | null;
    reason: string;
  };
  alerts: string[];
}

/** A report's quality score: canonical metrics first, pass/fail as fallback. */
export function evalReportScore(report: {
  metrics: Record<string, unknown> | null;
  passes: boolean;
}): number {
  const values = QUALITY_METRICS.map((key) => report.metrics?.[key]).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (values.length === 0) return report.passes ? 1 : 0;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4));
}

export async function readEvalBaselines(database: Database): Promise<StoredBaselines> {
  const stored = await readSetting<Partial<StoredBaselines>>(database, EVAL_BASELINES_KEY);
  const baseline = stored?.baseline;
  return {
    scores: Array.isArray(stored?.scores)
      ? stored.scores.filter(
          (score): score is number => typeof score === 'number' && Number.isFinite(score),
        )
      : [],
    reportIds: Array.isArray(stored?.reportIds)
      ? stored.reportIds.filter((id): id is string => typeof id === 'string')
      : [],
    baseline:
      baseline &&
      typeof baseline.mean === 'number' &&
      typeof baseline.stddev === 'number' &&
      typeof baseline.samples === 'number'
        ? baseline
        : null,
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : null,
  };
}

async function writeEvalBaselines(database: Database, baselines: StoredBaselines): Promise<void> {
  await database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, 'evals.nightly', now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [EVAL_BASELINES_KEY, baselines],
  );
}

async function auditAlert(
  database: Database,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await writeAudit(database, {
    actor: 'evals.nightly',
    action,
    subject: EVAL_BASELINES_KEY,
    payload,
  });
}

async function rollback(
  deps: NightlyEvalDeps,
  args: { component: string; modelId: string | null; reason: string },
): Promise<RollbackOutcome | null> {
  if (deps.rollback) return deps.rollback(args);
  if (!deps.registry) return null;
  return rollbackActiveModel(deps.database, deps.registry, {
    component: args.component,
    reason: args.reason,
    actor: 'evals.nightly',
  });
}

export async function runNightlyEvals(deps: NightlyEvalDeps): Promise<NightlyEvalResult> {
  const window = deps.baselineWindow ?? EVAL_BASELINE_WINDOW;
  const stored = await readEvalBaselines(deps.database);
  const reports = await deps.database.query<EvalReportRow>(
    `SELECT id, subject_model_id, metrics, passes, generated_at
       FROM eval_reports
      WHERE generated_at > now() - interval '30 days'
      ORDER BY generated_at ASC, created_at ASC
      LIMIT 200`,
  );
  const known = new Set(stored.reportIds);
  const newReports = reports.filter((report) => !known.has(report.id));
  const newScores = newReports.map(evalReportScore);
  const scores = [...stored.scores, ...newScores];
  const currentScore = scores.at(-1) ?? null;
  const baseline = scores.length > 1 ? rollingBaseline(scores.slice(0, -1).slice(-window)) : null;

  const drift: DriftResult =
    currentScore === null
      ? { drift: false, zScore: 0, reason: 'no_eval_reports' }
      : newReports.length === 0
        ? { drift: false, zScore: 0, reason: 'no_new_reports' }
        : detectDrift(currentScore, baseline ?? rollingBaseline([]), {
            absoluteThreshold: 0.2,
          });

  const configuredFloor = await readSetting<number>(deps.database, EVAL_SCORE_FLOOR_KEY);
  const floor =
    deps.floor ??
    (typeof configuredFloor === 'number' && Number.isFinite(configuredFloor)
      ? configuredFloor
      : DEFAULT_EVAL_SCORE_FLOOR);
  const rollbackDue = shouldAutoRollback(scores, floor, EVAL_ROLLBACK_WINDOWS);
  const autoRollbackEnabled =
    (await readSetting<boolean>(deps.database, EVAL_AUTO_ROLLBACK_KEY)) === true;

  let attempted = false;
  let performed = false;
  let rolledBackTo: string | null = null;
  let rollbackReason = 'not_due';
  const alerts: string[] = [];

  if (rollbackDue && newReports.length > 0) {
    const latestSubject = [...reports].reverse().find((report) => report.subject_model_id);
    if (!latestSubject?.subject_model_id) {
      rollbackReason = 'no_subject_model';
      alerts.push('eval_rollback_unavailable');
      await auditAlert(deps.database, 'alert.eval_rollback_unavailable', {
        reason: rollbackReason,
        currentScore,
        floor,
      });
    } else {
      const componentRows = await deps.database.query<{ component: string }>(
        `SELECT component FROM model_assets WHERE id = $1`,
        [latestSubject.subject_model_id],
      );
      const component = componentRows[0]?.component;
      if (!autoRollbackEnabled) {
        rollbackReason = 'auto_rollback_disabled';
        alerts.push('eval_drift');
        await auditAlert(deps.database, 'alert.eval_drift', {
          reason: rollbackReason,
          currentScore,
          floor,
          component: component ?? null,
          modelId: latestSubject.subject_model_id,
        });
      } else if (!component) {
        rollbackReason = 'model_not_found';
        alerts.push('eval_rollback_unavailable');
        await auditAlert(deps.database, 'alert.eval_rollback_unavailable', {
          reason: rollbackReason,
          modelId: latestSubject.subject_model_id,
        });
      } else {
        attempted = true;
        const outcome = await rollback(deps, {
          component,
          modelId: latestSubject.subject_model_id,
          reason: `online score below floor ${floor} for ${EVAL_ROLLBACK_WINDOWS} consecutive windows`,
        });
        if (outcome) {
          performed = true;
          rolledBackTo = outcome.rolledBackTo;
          rollbackReason = 'rolled_back';
          alerts.push('eval_auto_rollback');
          await auditAlert(deps.database, 'alert.eval_auto_rollback', {
            component,
            fromModelId: latestSubject.subject_model_id,
            rolledBackTo,
            currentScore,
            floor,
          });
        } else {
          rollbackReason = 'no_previous_passing_model';
          alerts.push('eval_rollback_unavailable');
          await auditAlert(deps.database, 'alert.eval_rollback_unavailable', {
            reason: rollbackReason,
            component,
            modelId: latestSubject.subject_model_id,
          });
        }
      }
    }
  } else if (drift.drift) {
    alerts.push('eval_drift');
    await auditAlert(deps.database, 'alert.eval_drift', {
      reason: drift.reason,
      currentScore,
      zScore: drift.zScore,
    });
  }

  if (newReports.length > 0) {
    const currentIds = new Set(reports.map((report) => report.id));
    const reportIds = [
      ...stored.reportIds.filter((id) => currentIds.has(id)),
      ...newReports.map((report) => report.id),
    ];
    await writeEvalBaselines(deps.database, {
      scores: scores.slice(-window),
      reportIds,
      baseline: scores.length > 1 ? rollingBaseline(scores.slice(0, -1).slice(-window)) : null,
      updatedAt: (deps.now ?? new Date()).toISOString(),
    });
  }

  return {
    reports: reports.length,
    newReports: newReports.length,
    currentScore,
    baseline,
    drift,
    rollbackDue,
    autoRollbackEnabled,
    rollback: {
      attempted,
      performed,
      rolledBackTo,
      reason: rollbackReason,
    },
    alerts,
  };
}
