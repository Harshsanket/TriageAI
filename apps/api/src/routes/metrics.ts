/**
 * Prometheus text metrics (Phase 2): counters are computed from the kernel's
 * own tables on scrape (no side channel). pino already carries runId/stageId
 * correlation in logs; histogram instrumentation lands with the k6 baseline.
 */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

const line = (name: string, labels: Record<string, string>, value: number): string =>
  `${name}{${Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(',')}} ${value}`;

export function registerMetricsRoute(app: FastifyInstance, kernel: Kernel): void {
  const safeQuery = async <T extends Record<string, unknown>>(text: string): Promise<Array<T>> => {
    try {
      return await kernel.database.query<T>(text);
    } catch {
      // Module tables may be absent in profiles where the module is disabled.
      return [];
    }
  };

  app.get('/metrics', async (_request, reply) => {
    const database = kernel.database;

    const runs = (await database.query(
      `SELECT status, COUNT(*)::int AS count FROM workflow_runs GROUP BY status`,
    )) as Array<{ status: string; count: number }>;
    const stages = (await database.query(
      `SELECT status, COUNT(*)::int AS count FROM stage_runs GROUP BY status`,
    )) as Array<{ status: string; count: number }>;
    const jobs = (await database.query(
      `SELECT queue, status, COUNT(*)::int AS count FROM queue_jobs GROUP BY queue, status`,
    )) as Array<{ queue: string; status: string; count: number }>;
    const dead = (await database.query(
      `SELECT queue, COUNT(*)::int AS count FROM queue_deadletters GROUP BY queue`,
    )) as Array<{ queue: string; count: number }>;
    const decisions = (await database.query(
      `SELECT COUNT(*)::int AS count FROM decision_records`,
    )) as Array<{ count: number }>;
    const stageLatency = await safeQuery<{ kind: string; count: number; sum_ms: number }>(
      `SELECT COALESCE(adapter_versions->>'handlerKind', 'unknown') AS kind,
              COUNT(*)::int AS count,
              COALESCE(SUM((timings->>'durationMs')::numeric), 0)::int AS sum_ms
       FROM decision_records
       WHERE timings ? 'durationMs'
       GROUP BY 1`,
    );
    const retries = await safeQuery<{ retried: number; total: number }>(
      `SELECT COUNT(*) FILTER (WHERE attempts > 1)::int AS retried,
              COUNT(*)::int AS total
       FROM stage_runs`,
    );
    const autoReplies = await safeQuery<{ state: string; count: number }>(
      `SELECT state, COUNT(*)::int AS count FROM support_auto_replies GROUP BY state`,
    );

    const lines: string[] = [
      '# HELP triageai_runs_total Workflow runs by terminal/current status.',
      '# TYPE triageai_runs_total gauge',
      ...runs.map((row) => line('triageai_runs_total', { status: row.status }, row.count)),
      '# HELP triageai_stage_runs_total Stage runs by status.',
      '# TYPE triageai_stage_runs_total gauge',
      ...stages.map((row) => line('triageai_stage_runs_total', { status: row.status }, row.count)),
      '# HELP triageai_queue_jobs Queue jobs by queue and status.',
      '# TYPE triageai_queue_jobs gauge',
      ...jobs.map((row) =>
        line('triageai_queue_jobs', { queue: row.queue, status: row.status }, row.count),
      ),
      '# HELP triageai_queue_deadletters Dead-lettered jobs by queue.',
      '# TYPE triageai_queue_deadletters gauge',
      ...dead.map((row) => line('triageai_queue_deadletters', { queue: row.queue }, row.count)),
      '# HELP triageai_decisions_total Append-only decision records.',
      '# TYPE triageai_decisions_total gauge',
      line('triageai_decisions_total', {}, decisions[0]?.count ?? 0),
      '# HELP triageai_stage_duration_ms Stage decision latency (count + sum).',
      '# TYPE triageai_stage_duration_ms gauge',
      ...stageLatency.flatMap((row) => [
        line('triageai_stage_duration_ms_count', { kind: row.kind }, row.count),
        line('triageai_stage_duration_ms_sum', { kind: row.kind }, row.sum_ms),
      ]),
      '# HELP triageai_stage_retries Stage runs that needed more than one attempt.',
      '# TYPE triageai_stage_retries gauge',
      line('triageai_stage_retries_total', {}, retries[0]?.retried ?? 0),
      line('triageai_stage_runs_attempted_total', {}, retries[0]?.total ?? 0),
      '# HELP triageai_auto_replies_total Auto-reply attempts by state.',
      '# TYPE triageai_auto_replies_total gauge',
      ...autoReplies.map((row) =>
        line('triageai_auto_replies_total', { state: row.state }, row.count),
      ),
      '# HELP process_resident_memory_bytes Node process RSS.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '# HELP process_uptime_seconds Node process uptime.',
      '# TYPE process_uptime_seconds gauge',
      `process_uptime_seconds ${process.uptime()}`,
      '',
    ];

    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return lines.join('\n');
  });
}
