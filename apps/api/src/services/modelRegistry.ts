/**
 * Postgres-backed model registry (Phase 6).
 *
 * The active asset is read by `ModelRegistry.active()`; the workflow stages
 * record it in `decision_records.adapter_versions`, so a rollback is visible on
 * the next run without a restart. Promotion is gated on a passing eval report
 * that does not regress the active baseline.
 */
import type { ModelAssetDto, ModelStatus } from '@triageai/contracts';
import type { ActiveModelAsset, Database, ModelRegistry } from '@triageai/kernel';

import { writeAudit } from './audit.js';

interface ModelRow {
  [key: string]: unknown;
  id: string;
  component: string;
  name: string;
  artifact_ref: string | null;
  config: Record<string, unknown>;
  eval_report_id: string | null;
  status: ModelStatus;
  promoted_at: Date | string | null;
  created_at: Date | string;
}

export class DbModelRegistry implements ModelRegistry {
  private cache = new Map<string, { at: number; asset: ActiveModelAsset | null }>();

  constructor(
    private readonly database: Database,
    private readonly ttlMs = 1_000,
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  async active(component: string): Promise<ActiveModelAsset | null> {
    const cached = this.cache.get(component);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.asset;
    const rows = (await this.database.query<ModelRow>(
      `SELECT id, component, name, artifact_ref, config, eval_report_id, status, promoted_at, created_at
       FROM model_assets
       WHERE component = $1 AND status = 'active'
       ORDER BY promoted_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [component],
    )) as unknown as ModelRow[];
    const row = rows[0];
    const asset: ActiveModelAsset | null = row
      ? {
          id: row.id,
          component: row.component,
          name: row.name,
          artifactRef: row.artifact_ref,
          config: row.config ?? {},
          evalReportId: row.eval_report_id,
          promotedAt: row.promoted_at ? new Date(row.promoted_at).toISOString() : null,
        }
      : null;
    this.cache.set(component, { at: Date.now(), asset });
    return asset;
  }
}

export function modelDto(row: {
  id: string;
  component: string;
  name: string;
  artifact_ref: string | null;
  config: Record<string, unknown> | null;
  eval_report_id: string | null;
  status: ModelStatus;
  promoted_at: Date | string | null;
  created_at: Date | string;
}): ModelAssetDto {
  return {
    id: row.id,
    component: row.component as ModelAssetDto['component'],
    name: row.name,
    artifactRef: row.artifact_ref,
    config: row.config ?? {},
    evalReportId: row.eval_report_id,
    status: row.status,
    promotedAt: row.promoted_at ? new Date(row.promoted_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export interface PromotionDecision {
  allowed: boolean;
  reasons: string[];
}

/**
 * Step-level evidence attached to a promotion (18.T24). Trajectory floors are
 * only consulted when a report is present, so end-to-end-only reports keep the
 * existing policy unchanged.
 */
export interface TrajectoryReport {
  pathEfficiency?: number | null;
  wastedSteps?: number;
  toolSelectionAccuracy?: number;
  steps?: Array<{ nodeId?: string; score: number; passed?: boolean }>;
}

export interface TrajectoryFloors {
  pathEfficiency?: number;
  /** Maximum tolerated wasted steps (inclusive). */
  wastedSteps?: number;
  toolSelectionAccuracy?: number;
  minStepScore?: number;
}

export const DEFAULT_TRAJECTORY_FLOORS: Required<TrajectoryFloors> = {
  pathEfficiency: 0.8,
  wastedSteps: 2,
  toolSelectionAccuracy: 0.9,
  minStepScore: 0.8,
};

export interface PromotionSubject {
  passes: boolean;
  metrics: Record<string, unknown>;
  trajectory?: TrajectoryReport | null;
}

export interface PromotionOptions {
  /** Explicit trajectory report; otherwise `subject.trajectory` or metrics. */
  trajectory?: TrajectoryReport | null;
  trajectoryFloors?: TrajectoryFloors;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Read a trajectory report from a subject or from report metric keys. */
function trajectoryReportOf(
  subject: PromotionSubject,
  explicit?: TrajectoryReport | null,
): TrajectoryReport | null {
  if (explicit !== undefined) return explicit;
  if (subject.trajectory !== undefined) return subject.trajectory;
  const embedded = subject.metrics.trajectory;
  if (embedded && typeof embedded === 'object' && !Array.isArray(embedded)) {
    return embedded as TrajectoryReport;
  }
  const pathEfficiency =
    finiteNumber(subject.metrics.trajectoryPathEfficiency) ??
    finiteNumber(subject.metrics.pathEfficiency);
  const wastedSteps = finiteNumber(subject.metrics.trajectoryWastedSteps);
  const toolSelectionAccuracy = finiteNumber(subject.metrics.toolSelectionAccuracy);
  if (
    pathEfficiency === undefined &&
    wastedSteps === undefined &&
    toolSelectionAccuracy === undefined
  ) {
    return null;
  }
  return {
    ...(pathEfficiency !== undefined ? { pathEfficiency } : {}),
    ...(wastedSteps !== undefined ? { wastedSteps } : {}),
    ...(toolSelectionAccuracy !== undefined ? { toolSelectionAccuracy } : {}),
  };
}

function trajectoryReasons(
  subject: TrajectoryReport,
  baseline: TrajectoryReport | null,
  floors: TrajectoryFloors,
): string[] {
  const limits = { ...DEFAULT_TRAJECTORY_FLOORS, ...floors };
  const reasons: string[] = [];
  if (
    subject.pathEfficiency !== undefined &&
    subject.pathEfficiency !== null &&
    subject.pathEfficiency < limits.pathEfficiency
  ) {
    reasons.push(
      `trajectory path efficiency ${subject.pathEfficiency} is below the floor ${limits.pathEfficiency}`,
    );
  }
  if (subject.wastedSteps !== undefined && subject.wastedSteps > limits.wastedSteps) {
    reasons.push(
      `trajectory wasted steps ${subject.wastedSteps} exceed the limit ${limits.wastedSteps}`,
    );
  }
  if (
    subject.toolSelectionAccuracy !== undefined &&
    subject.toolSelectionAccuracy < limits.toolSelectionAccuracy
  ) {
    reasons.push(
      `tool-selection accuracy ${subject.toolSelectionAccuracy} is below the floor ${limits.toolSelectionAccuracy}`,
    );
  }
  for (const step of subject.steps ?? []) {
    if (step.score < limits.minStepScore) {
      reasons.push(
        `step ${step.nodeId ?? 'unknown'} score ${step.score} is below the floor ${limits.minStepScore}`,
      );
    }
  }
  if (baseline) {
    if (
      subject.pathEfficiency !== undefined &&
      subject.pathEfficiency !== null &&
      baseline.pathEfficiency !== undefined &&
      baseline.pathEfficiency !== null &&
      subject.pathEfficiency < baseline.pathEfficiency
    ) {
      reasons.push(
        `trajectory path efficiency ${subject.pathEfficiency} regresses below baseline ${baseline.pathEfficiency}`,
      );
    }
    if (
      subject.toolSelectionAccuracy !== undefined &&
      baseline.toolSelectionAccuracy !== undefined &&
      subject.toolSelectionAccuracy < baseline.toolSelectionAccuracy
    ) {
      reasons.push(
        `tool-selection accuracy ${subject.toolSelectionAccuracy} regresses below baseline ${baseline.toolSelectionAccuracy}`,
      );
    }
  }
  return reasons;
}

/**
 * Pure promotion policy: safety first, then no regression against the baseline,
 * then step-level trajectory floors when a trajectory report is attached.
 */
export function evaluatePromotion(
  subject: PromotionSubject,
  baseline: PromotionSubject | null,
  options: PromotionOptions = {},
): PromotionDecision {
  const reasons: string[] = [];
  if (!subject.passes) reasons.push('subject eval report has not passed its gates');

  const falseAuto = subject.metrics.falseAutoRoutingCount;
  if (typeof falseAuto === 'number' && falseAuto > 0) {
    reasons.push(`false auto-routing is ${falseAuto} (must be 0 for safety-critical categories)`);
  }

  if (baseline) {
    const subjectF1 = subject.metrics.macroF1;
    const baselineF1 = baseline.metrics.macroF1;
    if (typeof subjectF1 === 'number' && typeof baselineF1 === 'number' && subjectF1 < baselineF1) {
      reasons.push(`macro F1 ${subjectF1} regresses below baseline ${baselineF1}`);
    }
    const baselineFalseAuto = baseline.metrics.falseAutoRoutingCount;
    if (
      typeof falseAuto === 'number' &&
      typeof baselineFalseAuto === 'number' &&
      falseAuto > baselineFalseAuto
    ) {
      reasons.push(`false auto-routing ${falseAuto} regresses above baseline ${baselineFalseAuto}`);
    }
  }

  const subjectTrajectory = trajectoryReportOf(subject, options.trajectory);
  if (subjectTrajectory) {
    const baselineTrajectory = baseline ? trajectoryReportOf(baseline) : null;
    reasons.push(
      ...trajectoryReasons(subjectTrajectory, baselineTrajectory, options.trajectoryFloors ?? {}),
    );
  }
  return { allowed: reasons.length === 0, reasons };
}

export interface AutoRollbackResult {
  rolledBackTo: string;
  fromModelId: string;
  component: string;
  name: string;
}

/**
 * Registry rollback reused by the nightly eval service (18.T2): restore the
 * most recently active previous asset after its passing eval report, audited
 * exactly like the manual `/models/:id/rollback` route.
 */
export async function rollbackActiveModel(
  database: Database,
  registry: { invalidate?: () => void },
  args: { component: string; reason: string; actor?: string | null },
): Promise<AutoRollbackResult | null> {
  const outcome = await database.transaction(async (tx) => {
    const activeRows = (await tx.query<ModelRow>(
      `SELECT * FROM model_assets
        WHERE component = $1 AND status = 'active'
        ORDER BY promoted_at DESC NULLS LAST, created_at DESC
        LIMIT 1 FOR UPDATE`,
      [args.component],
    )) as unknown as ModelRow[];
    const active = activeRows[0];
    if (!active) return null;

    const targetRows = (await tx.query<ModelRow>(
      `SELECT * FROM model_assets
        WHERE component = $1 AND status = 'rolled_back' AND promoted_at IS NOT NULL AND id <> $2
        ORDER BY promoted_at DESC LIMIT 1 FOR UPDATE`,
      [args.component, active.id],
    )) as unknown as ModelRow[];
    const target = targetRows[0];
    if (!target) return null;

    if (target.eval_report_id) {
      const reportRows = (await tx.query<{ passes: boolean }>(
        `SELECT passes FROM eval_reports WHERE id = $1`,
        [target.eval_report_id],
      )) as unknown as Array<{ passes: boolean }>;
      if (!reportRows[0]?.passes) return null;
    }

    await tx.query(`UPDATE model_assets SET status = 'rolled_back' WHERE id = $1`, [active.id]);
    await tx.query(`UPDATE model_assets SET status = 'active', promoted_at = now() WHERE id = $1`, [
      target.id,
    ]);
    return {
      rolledBackTo: target.id,
      fromModelId: active.id,
      component: target.component,
      name: target.name,
    };
  });

  if (!outcome) return null;
  registry.invalidate?.();
  await writeAudit(database, {
    actor: args.actor ?? 'evals.nightly',
    action: 'model.rolled_back',
    subject: outcome.rolledBackTo,
    payload: {
      component: outcome.component,
      name: outcome.name,
      fromModelId: outcome.fromModelId,
      reason: args.reason,
      auto: true,
    },
  });
  return outcome;
}
