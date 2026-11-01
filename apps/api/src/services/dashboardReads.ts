/**
 * Shared dashboard read model (ADR-0057): `/dashboard`, the operational
 * `system-status` KB snapshot and the read-only status tools consume the same
 * queries, so a metric is defined once.
 */
import { resolve } from 'node:path';

import type { Kernel } from '@triageai/kernel';

import { readStorage } from './storage.js';
import { summarizeUptime, type UptimeProbeRow } from './uptime.js';

interface CountRow {
  [key: string]: unknown;
  count: number;
}

interface StatusCountRow {
  [key: string]: unknown;
  status: string;
  count: number;
}

interface RunTotalsRow {
  [key: string]: unknown;
  runs_last_hour: number;
  active_runs: number;
}

interface RunRow {
  [key: string]: unknown;
  id: string;
  workflow_id: string;
  status: string;
  created_at: Date | string;
}

export const count = (value: unknown): number => Math.max(0, Number(value ?? 0));

export async function readQueue(kernel: Kernel) {
  const [backlog, dead] = await Promise.all([
    kernel.database.query<StatusCountRow>(
      `SELECT status, COUNT(*)::int AS count FROM queue_jobs
       WHERE status IN ('pending','processing') GROUP BY status`,
    ),
    kernel.database.query<CountRow>(`SELECT COUNT(*)::int AS count FROM queue_deadletters`),
  ]);
  const byStatus = Object.fromEntries(backlog.map((row) => [row.status, count(row.count)]));
  return {
    pending: byStatus.pending ?? 0,
    processing: byStatus.processing ?? 0,
    deadLetters: count(dead[0]?.count),
  };
}

export async function readActivity(kernel: Kernel) {
  const [totals, recent] = await Promise.all([
    kernel.database.query<RunTotalsRow>(
      `SELECT
         COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS runs_last_hour,
         COUNT(*) FILTER (WHERE status IN ('PENDING','RUNNING','AWAITING'))::int AS active_runs
       FROM workflow_runs`,
    ),
    kernel.database.query<RunRow>(
      `SELECT id, workflow_id, status, created_at FROM workflow_runs
       ORDER BY created_at DESC LIMIT 5`,
    ),
  ]);
  return {
    runsLastHour: count(totals[0]?.runs_last_hour),
    activeRuns: count(totals[0]?.active_runs),
    recentRuns: recent.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function readCostAndEfficiency(kernel: Kernel) {
  const [cost, calls] = await Promise.all([
    kernel.database.query<{
      today: number;
      month: number;
      tokens: number;
      calls: number;
    }>(
      `SELECT
         COALESCE(SUM(est_cost) FILTER (WHERE at >= date_trunc('day', now())), 0)::float AS today,
         COALESCE(SUM(est_cost) FILTER (WHERE at >= date_trunc('month', now())), 0)::float AS month,
         COALESCE(SUM(tokens_in + tokens_out) FILTER (WHERE at >= date_trunc('day', now())), 0)::int AS tokens,
         COUNT(*) FILTER (WHERE at >= date_trunc('day', now()))::int AS calls
       FROM cost_ledger`,
    ),
    kernel.database.query<{
      today: number;
      avg_latency: number | null;
      p95_latency: number | null;
      providers: Array<{ provider: string; calls: number }> | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE at >= date_trunc('day', now()))::int AS today,
         AVG((trace->>'latencyMs')::numeric)::float AS avg_latency,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY (trace->>'latencyMs')::numeric)::float AS p95_latency,
         (SELECT json_agg(json_build_object('provider', provider, 'calls', calls))
          FROM (SELECT trace->>'provider' AS provider, COUNT(*)::int AS calls
                FROM model_call_traces WHERE at >= date_trunc('day', now())
                GROUP BY 1 ORDER BY calls DESC) p) AS providers
       FROM model_call_traces`,
    ),
  ]);
  return {
    cost: {
      todayUsd: Number(cost[0]?.today ?? 0),
      monthToDateUsd: Number(cost[0]?.month ?? 0),
      tokensToday: count(cost[0]?.tokens),
      callsToday: count(cost[0]?.calls),
    },
    efficiency: {
      avgLatencyMs: calls[0]?.avg_latency == null ? null : Math.round(Number(calls[0].avg_latency)),
      p95LatencyMs: calls[0]?.p95_latency == null ? null : Math.round(Number(calls[0].p95_latency)),
      modelCallsToday: count(calls[0]?.today),
    },
    modelCalls: {
      today: count(calls[0]?.today),
      byProvider: calls[0]?.providers ?? [],
    },
  };
}

export interface ConnectedApiFact {
  name: string;
  type: string;
  status: string;
  baseUrl?: string;
}

interface RoleCountRow {
  [key: string]: unknown;
  role: string;
  count: number;
}

export async function readSecurity(kernel: Kernel, authMode: string) {
  const [roles, audit] = await Promise.all([
    kernel.database.query<RoleCountRow>(
      `SELECT role, COUNT(*)::int AS count FROM users GROUP BY role`,
    ),
    kernel.database.query<CountRow>(
      `SELECT COUNT(*)::int AS count FROM audit_events
       WHERE created_at > now() - interval '24 hours'`,
    ),
  ]);
  const usersByRole = { customer: 0, agent: 0, admin: 0 };
  for (const row of roles) {
    if (row.role === 'customer' || row.role === 'agent' || row.role === 'admin') {
      usersByRole[row.role] = count(row.count);
    }
  }
  return {
    authMode,
    usersByRole,
    auditEventsLastDay: count(audit[0]?.count),
  };
}

export interface SystemStatusSnapshot {
  asOf: string;
  database: 'up' | 'down';
  health: { status: string; modules: Array<{ id: string; health: string }> };
  queue: { pending: number; processing: number; deadLetters: number };
  activity: { runsLastHour: number; activeRuns: number };
  storage: { totalBytes: number; categories: Array<{ category: string; bytes: number }> } | null;
  cost: { tokensToday: number; callsToday: number; todayUsd: number };
  modelSpeed: { avgLatencyMs: number | null; p95LatencyMs: number | null };
  uptime: {
    systemUptimePct: number;
    services: Array<{ target: string; uptimePct: number; currentOk: boolean | null }>;
  };
  connectedApis: ConnectedApiFact[];
}

export async function readSystemStatus(
  kernel: Kernel,
  opts: { connectedApis?: ConnectedApiFact[] } = {},
): Promise<SystemStatusSnapshot> {
  let database: 'up' | 'down' = 'up';
  try {
    await kernel.database.query(`SELECT 1`);
  } catch {
    database = 'down';
  }
  if (database === 'down') {
    return {
      asOf: new Date().toISOString(),
      database,
      health: { status: 'down', modules: [] },
      queue: { pending: 0, processing: 0, deadLetters: 0 },
      activity: { runsLastHour: 0, activeRuns: 0 },
      storage: null,
      cost: { tokensToday: 0, callsToday: 0, todayUsd: 0 },
      modelSpeed: { avgLatencyMs: null, p95LatencyMs: null },
      uptime: { systemUptimePct: 0, services: [] },
      connectedApis: opts.connectedApis ?? [],
    };
  }

  const [modules, queue, activity, cost, storage, uptimeRows] = await Promise.all([
    kernel.health().catch(() => []),
    readQueue(kernel).catch(() => ({ pending: 0, processing: 0, deadLetters: 0 })),
    readActivity(kernel).catch(() => ({ runsLastHour: 0, activeRuns: 0, recentRuns: [] })),
    readCostAndEfficiency(kernel).catch(() => ({
      cost: { todayUsd: 0, monthToDateUsd: 0, tokensToday: 0, callsToday: 0 },
      efficiency: { avgLatencyMs: null, p95LatencyMs: null, modelCallsToday: 0 },
      modelCalls: { today: 0, byProvider: [] },
    })),
    readStorage(kernel.database, {
      blobRoot:
        process.env.TRIAGEAI_BLOB_ROOT ??
        resolve(process.env.TRIAGEAI_DATA_DIR ?? process.cwd(), 'data/blobs'),
      pluginsRoot: process.env.TRIAGEAI_PLUGINS_DIR,
      modelRoot: process.env.TRIAGEAI_MODEL_DIR ?? '/models',
      logRoot: process.env.TRIAGEAI_LOG_DIR,
    }).catch(() => null),
    kernel.database
      .query<UptimeProbeRow>(
        `SELECT target, at, ok, latency_ms FROM uptime_probes
          WHERE at > now() - interval '24 hours' ORDER BY at`,
      )
      .catch(() => []),
  ]);

  const moduleWorst = modules.some((module) => module.health === 'down')
    ? 'down'
    : modules.some((module) => module.health === 'degraded')
      ? 'degraded'
      : 'healthy';
  const uptime = summarizeUptime(uptimeRows, Math.floor(process.uptime()));

  return {
    asOf: new Date().toISOString(),
    database,
    health: {
      status: moduleWorst,
      modules: modules.map((module) => ({ id: module.id, health: module.health ?? 'healthy' })),
    },
    queue,
    activity: { runsLastHour: activity.runsLastHour, activeRuns: activity.activeRuns },
    storage: storage
      ? {
          totalBytes: storage.totalBytes,
          categories: storage.byCategory.map((category) => ({
            category: category.category,
            bytes: category.bytes,
          })),
        }
      : null,
    cost: {
      tokensToday: cost.cost.tokensToday,
      callsToday: cost.cost.callsToday,
      todayUsd: cost.cost.todayUsd,
    },
    modelSpeed: {
      avgLatencyMs: cost.efficiency.avgLatencyMs,
      p95LatencyMs: cost.efficiency.p95LatencyMs,
    },
    uptime: {
      systemUptimePct: uptime.systemUptimePct,
      services: uptime.targets.map((service) => ({
        target: service.target,
        uptimePct: service.uptimePct,
        currentOk: service.currentOk,
      })),
    },
    connectedApis: opts.connectedApis ?? [],
  };
}
