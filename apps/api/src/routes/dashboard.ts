/**
 * `/dashboard` v1 read model (Phase 19.4): one admin screen aggregated from
 * existing host surfaces — module health, queue depth, runs, KB documents and
 * identity/audit counters. No new instrumentation, no module route calls.
 */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';
import { SystemDashboardSchema } from '@triageai/contracts';
import type {
  DashboardAgent,
  DashboardKnowledge,
  DashboardKnowledgeGrowth,
  DashboardUsage,
} from '@triageai/contracts';

import { resolve } from 'node:path';

import type { SetupRuntime } from '../setup/boot.js';
import { readStorage } from '../services/storage.js';
import { summarizeUptime, type UptimeProbeRow } from '../services/uptime.js';
import { readModelRuntimes } from '../services/modelRuntimes.js';
import { getControls } from '../services/controls.js';

import {
  count,
  readActivity,
  readCostAndEfficiency,
  readQueue,
  readSecurity,
} from '../services/dashboardReads.js';

interface UsageQuery {
  window?: 'day' | 'month' | 'year' | 'custom';
  from?: string;
  to?: string;
}

export async function readModelUsage(
  kernel: Kernel,
  query: UsageQuery = {},
): Promise<import('@triageai/contracts').DashboardModelUsage> {
  const now = new Date();
  const window = query.window ?? 'day';
  const bucketUnit = window === 'day' ? 'hour' : window === 'year' ? 'month' : 'day';
  const defaultStart =
    window === 'day'
      ? new Date(now.getTime() - 24 * 60 * 60 * 1000)
      : window === 'month'
        ? new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000)
        : window === 'year'
          ? new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000)
          : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = query.from ? new Date(query.from) : defaultStart;
  const to = query.to ? new Date(query.to) : now;
  const bucketExpr = `to_char(date_trunc('${bucketUnit}', c.at), 'YYYY-MM-DD"T"HH24:00')`;

  const [ledger, traces] = await Promise.all([
    kernel.database
      .query<{
        bucket: string;
        provider: string;
        model: string;
        agent_id: string | null;
        module: string | null;
        tokens_in: number;
        tokens_out: number;
      }>(
        `SELECT ${bucketExpr} AS bucket,
                c.provider, c.model, c.agent_id,
                split_part(r.workflow_id, '.', 1) AS module,
                COALESCE(SUM(c.tokens_in), 0)::int AS tokens_in,
                COALESCE(SUM(c.tokens_out), 0)::int AS tokens_out
           FROM cost_ledger c
           LEFT JOIN workflow_runs r ON r.id = c.run_id
          WHERE c.at >= $1 AND c.at <= $2
          GROUP BY 1, 2, 3, 4, 5
          ORDER BY 1`,
        [from, to],
      )
      .catch(() => []),
    kernel.database
      .query<{
        provider: string;
        model: string;
        calls: number;
        ttft_mean: number | null;
        ttft_p95: number | null;
        speed_mean: number | null;
        speed_p95: number | null;
        latency_mean: number | null;
        latency_p95: number | null;
        failures: number;
        fallbacks: number;
        timeouts: number;
      }>(
        `SELECT trace->>'provider' AS provider,
                trace->>'modelName' AS model,
                COUNT(*)::int AS calls,
                AVG((trace->>'timeToFirstTokenMs')::numeric)::float AS ttft_mean,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (trace->>'timeToFirstTokenMs')::numeric)::float AS ttft_p95,
                AVG((trace->>'tokensPerSecond')::numeric)::float AS speed_mean,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (trace->>'tokensPerSecond')::numeric)::float AS speed_p95,
                AVG((trace->>'latencyMs')::numeric)::float AS latency_mean,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY (trace->>'latencyMs')::numeric)::float AS latency_p95,
                COUNT(*) FILTER (WHERE trace->>'errorCode' IS NOT NULL)::int AS failures,
                COUNT(*) FILTER (WHERE COALESCE(trace->>'fallbackUsed', 'none') <> 'none')::int AS fallbacks,
                COUNT(*) FILTER (WHERE trace->>'errorCategory' = 'timeout')::int AS timeouts
           FROM model_call_traces
          WHERE at >= $1 AND at <= $2
          GROUP BY 1, 2`,
        [from, to],
      )
      .catch(() => []),
  ]);

  const points = new Map<
    string,
    {
      bucket: string;
      byModel: Record<string, { tokensIn: number; tokensOut: number }>;
      byAgent: Record<string, number>;
      byModule: Record<string, number>;
    }
  >();
  let tokensIn = 0;
  let tokensOut = 0;
  for (const row of ledger) {
    tokensIn += row.tokens_in;
    tokensOut += row.tokens_out;
    const point = points.get(row.bucket) ?? {
      bucket: row.bucket,
      byModel: {},
      byAgent: {},
      byModule: {},
    };
    const model = `${row.provider}/${row.model}`;
    const entry = point.byModel[model] ?? { tokensIn: 0, tokensOut: 0 };
    entry.tokensIn += row.tokens_in;
    entry.tokensOut += row.tokens_out;
    point.byModel[model] = entry;
    if (row.agent_id) {
      point.byAgent[row.agent_id] =
        (point.byAgent[row.agent_id] ?? 0) + row.tokens_in + row.tokens_out;
    }
    if (row.module) {
      point.byModule[row.module] =
        (point.byModule[row.module] ?? 0) + row.tokens_in + row.tokens_out;
    }
    points.set(row.bucket, point);
  }

  const tokenByModel = new Map<string, { tokensIn: number; tokensOut: number }>();
  for (const row of ledger) {
    const key = `${row.provider}/${row.model}`;
    const entry = tokenByModel.get(key) ?? { tokensIn: 0, tokensOut: 0 };
    entry.tokensIn += row.tokens_in;
    entry.tokensOut += row.tokens_out;
    tokenByModel.set(key, entry);
  }
  const byModel = traces.map((row) => {
    const key = `${row.provider}/${row.model}`;
    const tokens = tokenByModel.get(key) ?? { tokensIn: 0, tokensOut: 0 };
    return {
      provider: row.provider,
      model: row.model,
      calls: row.calls,
      tokensIn: tokens.tokensIn,
      tokensOut: tokens.tokensOut,
      ttftMeanMs: row.ttft_mean == null ? null : Number(row.ttft_mean.toFixed(2)),
      ttftP95Ms: row.ttft_p95 == null ? null : Number(row.ttft_p95.toFixed(2)),
      tokensPerSecondMean: row.speed_mean == null ? null : Number(row.speed_mean.toFixed(2)),
      tokensPerSecondP95: row.speed_p95 == null ? null : Number(row.speed_p95.toFixed(2)),
      generationMeanMs: row.latency_mean == null ? null : Number(row.latency_mean.toFixed(2)),
      generationP95Ms: row.latency_p95 == null ? null : Number(row.latency_p95.toFixed(2)),
    };
  });

  return {
    window,
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      tokensIn,
      tokensOut,
      calls: traces.reduce((sum, row) => sum + row.calls, 0),
      failures: traces.reduce((sum, row) => sum + row.failures, 0),
      fallbacks: traces.reduce((sum, row) => sum + row.fallbacks, 0),
      timeouts: traces.reduce((sum, row) => sum + row.timeouts, 0),
    },
    points: [...points.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    byModel: byModel.sort((a, b) => b.calls - a.calls),
  };
}

async function readUsage(kernel: Kernel): Promise<DashboardUsage> {
  const [runs, cost] = await Promise.all([
    kernel.database
      .query<{ bucket: string; module: string; runs: number }>(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS bucket,
                split_part(workflow_id, '.', 1) AS module,
                COUNT(*)::int AS runs
           FROM workflow_runs
          WHERE created_at > now() - interval '14 days'
          GROUP BY 1, 2 ORDER BY 1`,
      )
      .catch(() => []),
    kernel.database
      .query<{ bucket: string; tokens: number; cost: number }>(
        `SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS bucket,
                COALESCE(SUM(tokens_in + tokens_out), 0)::int AS tokens,
                COALESCE(SUM(est_cost), 0)::float AS cost
           FROM cost_ledger
          WHERE at > now() - interval '14 days'
          GROUP BY 1 ORDER BY 1`,
      )
      .catch(() => []),
  ]);
  const buckets = new Map<
    string,
    {
      bucket: string;
      runs: number;
      tokens: number;
      cost: number;
      chatMessages: number;
      tickets: number;
      byModule: Record<string, number>;
    }
  >();
  const ensure = (bucket: string) => {
    const existing = buckets.get(bucket);
    if (existing) return existing;
    const created = {
      bucket,
      runs: 0,
      tokens: 0,
      cost: 0,
      chatMessages: 0,
      tickets: 0,
      byModule: {} as Record<string, number>,
    };
    buckets.set(bucket, created);
    return created;
  };
  for (const row of runs) {
    const point = ensure(row.bucket);
    point.runs += count(row.runs);
    point.byModule[row.module] = (point.byModule[row.module] ?? 0) + count(row.runs);
  }
  for (const row of cost) {
    const point = ensure(row.bucket);
    point.tokens += count(row.tokens);
    point.cost += Number(row.cost ?? 0);
  }
  return {
    window: 'day',
    points: [...buckets.values()]
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
      .map((point) => ({ ...point, cost: Number(point.cost.toFixed(4)) })),
  };
}

const AGENT_PALETTE = [
  '#3b6fd4',
  '#d9730d',
  '#2f8f6b',
  '#b4467a',
  '#7c5cc4',
  '#a16207',
  '#0e7490',
  '#c2410c',
  '#4d7c0f',
  '#9f1239',
];

async function readAgents(kernel: Kernel): Promise<DashboardAgent[]> {
  const [definitions, usage] = await Promise.all([
    kernel.database
      .query<{ id: string; display_name: string; definition: Record<string, unknown> }>(
        `SELECT id, display_name, definition FROM agent_definitions ORDER BY updated_at DESC LIMIT 50`,
      )
      .catch(() => []),
    kernel.database
      .query<{ agent_id: string; runs: number; tokens: number; cost: number }>(
        `SELECT agent_id, COUNT(DISTINCT run_id)::int AS runs,
                COALESCE(SUM(tokens_in + tokens_out), 0)::int AS tokens,
                COALESCE(SUM(est_cost), 0)::float AS cost
           FROM cost_ledger
          WHERE agent_id IS NOT NULL AND at > now() - interval '24 hours'
          GROUP BY agent_id`,
      )
      .catch(() => []),
  ]);
  const byAgent = new Map(usage.map((row) => [row.agent_id, row]));
  return definitions.map((definition, index) => {
    const used = byAgent.get(definition.id);
    return {
      id: definition.id,
      displayName: definition.display_name,
      color:
        (definition.definition.color as string | undefined) ??
        (AGENT_PALETTE[index % AGENT_PALETTE.length] as string),
      running: 0,
      runs: count(used?.runs),
      tokens: count(used?.tokens),
      cost: Number(used?.cost ?? 0),
      succeeded: 0,
      failed: 0,
      series: [],
    };
  });
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  setup: SetupRuntime,
): void {
  app.get('/api/v1/system/usage', async (request) => {
    const query = request.query as UsageQuery;
    return readModelUsage(kernel, query);
  });

  app.get('/api/v1/system/storage', async () =>
    readStorage(kernel.database, {
      blobRoot:
        process.env.TRIAGEAI_BLOB_ROOT ??
        resolve(process.env.TRIAGEAI_DATA_DIR ?? process.cwd(), 'data/blobs'),
      pluginsRoot: process.env.TRIAGEAI_PLUGINS_DIR,
      modelRoot: process.env.TRIAGEAI_MODEL_DIR ?? '/models',
      logRoot: process.env.TRIAGEAI_LOG_DIR,
    }),
  );

  app.get('/api/v1/system/dashboard', async () => {
    const manifest = kernel.manifest();
    const enabled = new Set(manifest.modules.map((module) => module.id));

    let database: 'up' | 'down' = 'up';
    try {
      await kernel.database.query(`SELECT 1`);
    } catch {
      database = 'down';
    }

    const modules = (await kernel.health()).map((module) => ({
      id: module.id,
      version: module.version,
      health: module.health ?? 'healthy',
    }));
    const capabilities = Object.entries(kernel.config.capabilities).map(([id, capability]) => ({
      id,
      adapter: capability.adapter,
    }));

    const moduleWorst = modules.some((module) => module.health === 'down')
      ? 'down'
      : modules.some((module) => module.health === 'degraded')
        ? 'degraded'
        : 'healthy';

    const queue =
      database === 'down' ? { pending: 0, processing: 0, deadLetters: 0 } : await readQueue(kernel);
    const activity =
      database === 'down'
        ? { runsLastHour: 0, activeRuns: 0, recentRuns: [] }
        : await readActivity(kernel);
    const security =
      database === 'down'
        ? {
            authMode: setup.authMode,
            usersByRole: { customer: 0, agent: 0, admin: 0 },
            auditEventsLastDay: 0,
          }
        : await readSecurity(kernel, setup.authMode);

    const costAndEfficiency =
      database === 'down'
        ? {
            cost: { todayUsd: 0, monthToDateUsd: 0, tokensToday: 0, callsToday: 0 },
            efficiency: { avgLatencyMs: null, p95LatencyMs: null, modelCallsToday: 0 },
            modelCalls: { today: 0, byProvider: [] },
          }
        : await readCostAndEfficiency(kernel).catch(() => ({
            cost: { todayUsd: 0, monthToDateUsd: 0, tokensToday: 0, callsToday: 0 },
            efficiency: { avgLatencyMs: null, p95LatencyMs: null, modelCallsToday: 0 },
            modelCalls: { today: 0, byProvider: [] },
          }));

    const providers =
      database === 'down' ? [] : await kernel.readDashboardProviders().catch(() => []);
    const providerValue = <T>(key: string): T | undefined => {
      for (const provider of providers) {
        if (provider[key] !== undefined) return provider[key] as T;
      }
      return undefined;
    };
    const knowledge = enabled.has('kb')
      ? ((providerValue('knowledge') as DashboardKnowledge | undefined) ?? null)
      : null;
    const baseUsage =
      database === 'down'
        ? { window: 'day' as const, points: [] }
        : await readUsage(kernel).catch(() => ({ window: 'day' as const, points: [] }));
    const chatUsage = providerValue<Array<{ bucket: string; count: number }>>('usageChat') ?? [];
    const ticketUsage =
      providerValue<Array<{ bucket: string; count: number }>>('usageTickets') ?? [];
    const usagePoints = new Map(baseUsage.points.map((point) => [point.bucket, { ...point }]));
    const ensureUsage = (bucket: string) => {
      const existing = usagePoints.get(bucket);
      if (existing) return existing;
      const created = {
        bucket,
        runs: 0,
        tokens: 0,
        cost: 0,
        chatMessages: 0,
        tickets: 0,
        byModule: {} as Record<string, number>,
      };
      usagePoints.set(bucket, created);
      return created;
    };
    for (const row of chatUsage) ensureUsage(row.bucket).chatMessages += count(row.count);
    for (const row of ticketUsage) ensureUsage(row.bucket).tickets += count(row.count);
    const usage = {
      window: baseUsage.window,
      points: [...usagePoints.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    };
    const knowledgePoints =
      providerValue<Array<{ bucket: string; sources: number; documents: number; chunks: number }>>(
        'knowledgePoints',
      ) ?? [];
    const datasetPoints =
      providerValue<Array<{ bucket: string; datasets: number }>>('datasetPoints') ?? [];
    let knowledgeGrowth: DashboardKnowledgeGrowth | null = null;
    if (enabled.has('kb')) {
      const buckets = new Map<
        string,
        { bucket: string; sources: number; documents: number; chunks: number; datasets: number }
      >(knowledgePoints.map((point) => [point.bucket, { ...point, datasets: 0 }]));
      for (const point of datasetPoints) {
        const existing = buckets.get(point.bucket);
        if (existing) existing.datasets += point.datasets;
        else
          buckets.set(point.bucket, {
            bucket: point.bucket,
            sources: 0,
            documents: 0,
            chunks: 0,
            datasets: point.datasets,
          });
      }
      knowledgeGrowth = {
        points: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
        ingestJobs: Number(providerValue('ingestJobs') ?? 0),
        failures: Number(providerValue('ingestFailures') ?? 0),
      };
    }
    const graphs = {
      usage,
      agents: database === 'down' ? [] : await readAgents(kernel).catch(() => []),
      knowledgeGrowth,
      pinnedDatasets: enabled.has('data-extract') ? (providerValue('pinnedDatasets') ?? []) : [],
    };
    const modelUsage = await readModelUsage(kernel, { window: 'day' }).catch(() => null);
    const modelRuntimes = await readModelRuntimes(kernel).catch(() => []);
    const controls = await getControls(kernel.database);
    const uptimeRows =
      database === 'down'
        ? []
        : await kernel.database
            .query<UptimeProbeRow>(
              `SELECT target, at, ok, latency_ms FROM uptime_probes
                WHERE at > now() - interval '24 hours' ORDER BY at`,
            )
            .catch(() => []);
    const uptime = { ...summarizeUptime(uptimeRows, Math.floor(process.uptime())), restarts: 0 };
    const storage = await readStorage(kernel.database, {
      blobRoot:
        process.env.TRIAGEAI_BLOB_ROOT ??
        resolve(process.env.TRIAGEAI_DATA_DIR ?? process.cwd(), 'data/blobs'),
      pluginsRoot: process.env.TRIAGEAI_PLUGINS_DIR,
      modelRoot: process.env.TRIAGEAI_MODEL_DIR ?? '/models',
      logRoot: process.env.TRIAGEAI_LOG_DIR,
    }).catch(() => null);

    return SystemDashboardSchema.parse({
      generatedAt: new Date().toISOString(),
      ...graphs,
      health: {
        status: database === 'down' ? 'down' : moduleWorst,
        database,
        modules,
        capabilities,
        queue,
      },
      activity,
      knowledge,
      security,
      ...costAndEfficiency,
      modelUsage,
      modelRuntimes,
      llmDisabled: controls.llmDisabled,
      uptime,
      storage,
    });
  });
}
