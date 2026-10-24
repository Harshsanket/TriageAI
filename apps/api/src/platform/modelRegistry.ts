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

/** Pure promotion policy: safety first, then no regression against the baseline. */
export function evaluatePromotion(
  subject: { passes: boolean; metrics: Record<string, unknown> },
  baseline: { passes: boolean; metrics: Record<string, unknown> } | null,
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
  return { allowed: reasons.length === 0, reasons };
}
