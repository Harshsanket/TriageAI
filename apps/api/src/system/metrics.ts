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
