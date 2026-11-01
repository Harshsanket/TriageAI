import type { FastifyInstance } from 'fastify';

import { evaluateAlerts } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

export function registerAlertRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/alerts', async () => {
    const [runs, queue, approvals, egress, tokens] = await Promise.all([
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
      }),
    };
  });
}
