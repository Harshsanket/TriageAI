import type { FastifyInstance } from 'fastify';

import { detectDrift, evaluateAlerts, rollingBaseline } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

interface EvalMetricsRow {
  [key: string]: unknown;
  metrics: Record<string, unknown> | null;
}

/** Canonical 0–1 quality metrics, most specific first. */
const DRIFT_METRICS = ['groundedness', 'macroF1', 'recallAt3', 'mrr'] as const;

/**
 * Eval drift for the alerts endpoint (18.1): compare the newest report in each
 * canonical metric with the rolling baseline of the older reports. Fewer than
 * three data points for a metric means there is no honest drift verdict, so it
 * is skipped. `rows` arrive newest first (SQL ORDER BY generated_at DESC).
 */
export function detectEvalDrift(rows: EvalMetricsRow[]): boolean {
  const oldestFirst = [...rows].reverse();
  for (const metric of DRIFT_METRICS) {
    const series = oldestFirst
      .map((row) => row.metrics?.[metric])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (series.length < 3) continue;
    const current = series[series.length - 1];
    if (current === undefined) continue;
    if (detectDrift(current, rollingBaseline(series.slice(0, -1))).drift) return true;
  }
  return false;
}

export function registerAlertRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/alerts', async () => {
    const [runs, queue, approvals, egress, tokens, evalReports] = await Promise.all([
      kernel.database.query<{ total: number; failed: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
         FROM workflow_runs WHERE created_at > now() - interval '5 minutes'`,
      ),
      kernel.database.query<{ pending: number }>(
        `SELECT COUNT(*)::int AS pending FROM queue_jobs WHERE status = 'pending'`,
      ),
      kernel.database.query<{ stuck: number }>(
        `SELECT COUNT(*)::int AS stuck FROM approvals
         WHERE status = 'pending' AND created_at < now() - interval '1 hour'`,
      ),
      kernel.database.query<{ denied: number }>(
        `SELECT COUNT(*)::int AS denied FROM audit_events
         WHERE action = 'egress.denied' AND created_at > now() - interval '1 hour'`,
      ),
      kernel.database.query<{ provider: string; tokens: number }>(
        `SELECT provider, SUM(tokens_in + tokens_out)::int AS tokens
         FROM cost_ledger WHERE at >= date_trunc('day', now()) GROUP BY provider`,
      ),
      kernel.database.query<EvalMetricsRow>(
        `SELECT metrics FROM eval_reports
         WHERE generated_at > now() - interval '30 days'
         ORDER BY generated_at DESC LIMIT 20`,
      ),
    ]);
    const total = runs[0]?.total ?? 0;
    const failed = runs[0]?.failed ?? 0;
    const budgets = kernel.config.hosted?.budgets ?? {};
    const burns = tokens
      .map((row) => {
        const cap = budgets[row.provider]?.dailyTokens;
        return cap ? row.tokens / cap : undefined;
      })
      .filter((value): value is number => value !== undefined);
    return {
      generatedAt: new Date().toISOString(),
      alerts: evaluateAlerts({
        errorRate: total === 0 ? 0 : failed / total,
        queueDepth: queue[0]?.pending ?? 0,
        stuckApprovals: approvals[0]?.stuck ?? 0,
        egressDenials: egress[0]?.denied ?? 0,
        ...(burns.length > 0 ? { budgetBurn: Math.max(...burns) } : {}),
        // Watchdog decisions are not persisted yet (17.T2 is a pure rule
        // function), so watchdogInterventions stays unset instead of guessing.
        drift: detectEvalDrift(evalReports),
      }),
    };
  });
}
