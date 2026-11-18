/**
 * `/dashboard` v1 read model (Phase 19.4): one admin screen aggregated from
 * existing host surfaces — module health, queue depth, runs, KB documents and
 * identity/audit counters. No new instrumentation, no module route calls.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { coordinationOverhead, evaluateAlerts, routineReceipt } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';
import { SystemDashboardSchema } from '@triageai/contracts';
import type {
  DashboardAgent,
  DashboardKnowledge,
  DashboardKnowledgeGrowth,
  DashboardTrajectory,
  DashboardUsage,
  SystemDashboard,
} from '@triageai/contracts';

import { resolve } from 'node:path';

import type { SetupRuntime } from '../setup/boot.js';
import { readStorage } from '../services/storage.js';
import { countRestarts, summarizeUptime, type UptimeProbeRow } from '../services/uptime.js';
import { readModelRuntimes } from '../services/modelRuntimes.js';
import { getControls } from '../services/controls.js';
import { readTrajectoryQuality } from '../services/trajectory.js';
import { readPipelineSuggestions } from '../services/workflowHistory.js';
import { detectEvalDrift } from './alerts.js';

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

const EMPTY_TRAJECTORY: DashboardTrajectory = {
  runs: 0,
  averagePathEfficiency: null,
  stepPassRate: null,
  wastedSteps: 0,
  redundantSteps: 0,
  mostCommonFailingStep: null,
};

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
                COALESCE(c.provider, 'unknown') AS provider,
                COALESCE(c.model, 'unknown') AS model,
                c.agent_id,
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
        `SELECT COALESCE(trace->>'provider', 'unknown') AS provider,
                COALESCE(trace->>'modelName', 'unknown') AS model,
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

async function readFlags(kernel: Kernel): Promise<{ total: number; runs: number; rate: number }> {
  const [flags, runs] = await Promise.all([
    kernel.database
      .query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM audit_events
          WHERE action = 'run.flagged' AND created_at > now() - interval '24 hours'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM workflow_runs
          WHERE created_at > now() - interval '24 hours'`,
      )
      .catch(() => []),
  ]);
  const total = Number(flags[0]?.total ?? 0);
  const runTotal = Number(runs[0]?.total ?? 0);
  return { total, runs: runTotal, rate: runTotal > 0 ? total / runTotal : 0 };
}

async function readQuality(kernel: Kernel): Promise<{
  reports: number;
  passes: number;
  passRate: number | null;
  drift: boolean | null;
  refusalRate: number | null;
  escalationRate: number | null;
  autoResolveRate: number | null;
}> {
  const [rows, refusals, replies, resolved] = await Promise.all([
    kernel.database
      .query<{ metrics: Record<string, unknown> | null; passes: boolean }>(
        `SELECT metrics, passes FROM eval_reports
          WHERE generated_at > now() - interval '30 days'
          ORDER BY generated_at DESC LIMIT 200`,
      )
      .catch(() => []),
    kernel.database
      .query<{ refused: number; total: number }>(
        `SELECT COUNT(*) FILTER
                  (WHERE COALESCE((d.deterministic->>'refused')::boolean, false))::int AS refused,
                COUNT(*)::int AS total
           FROM decision_records d
           JOIN stage_runs s ON s.id = d.stage_run_id
          WHERE s.kind = 'chat.deliver'
            AND d.created_at > now() - interval '30 days'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ escalated: number; total: number }>(
        `SELECT COUNT(*) FILTER (WHERE state = 'escalated')::int AS escalated,
                COUNT(*)::int AS total
           FROM support_auto_replies
          WHERE created_at > now() - interval '30 days'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ resolved: number; replied: number }>(
        `SELECT COUNT(*) FILTER
                  (WHERE t.status = 'RESOLVED' AND latest.state IN ('sent', 'confirmed'))::int AS resolved,
                COUNT(*)::int AS replied
           FROM (SELECT DISTINCT ON (ticket_id) ticket_id, state
                   FROM support_auto_replies
                  WHERE created_at > now() - interval '30 days'
                  ORDER BY ticket_id, created_at DESC) latest
           JOIN support_tickets t ON t.id = latest.ticket_id`,
      )
      .catch(() => []),
  ]);
  const rate = (part: number, total: number): number | null =>
    total === 0 ? null : Number((part / total).toFixed(3));
  const refusalRow = refusals[0];
  const replyRow = replies[0];
  const resolvedRow = resolved[0];
  return {
    reports: rows.length,
    passes: rows.filter((row) => row.passes).length,
    passRate:
      rows.length === 0
        ? null
        : Number((rows.filter((row) => row.passes).length / rows.length).toFixed(3)),
    drift: rows.length === 0 ? null : detectEvalDrift(rows),
    refusalRate: rate(Number(refusalRow?.refused ?? 0), Number(refusalRow?.total ?? 0)),
    escalationRate: rate(Number(replyRow?.escalated ?? 0), Number(replyRow?.total ?? 0)),
    autoResolveRate: rate(Number(resolvedRow?.resolved ?? 0), Number(resolvedRow?.replied ?? 0)),
  };
}

async function readAudit(kernel: Kernel): Promise<{
  lastDay: number;
  recent: Array<{ action: string; actor: string | null; at: string }>;
}> {
  const [counts, recent] = await Promise.all([
    kernel.database
      .query<{ total: number }>(
        `SELECT COUNT(*)::int AS total FROM audit_events WHERE created_at > now() - interval '24 hours'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ action: string; actor: string | null; created_at: string | Date }>(
        `SELECT action, actor, created_at FROM audit_events ORDER BY created_at DESC LIMIT 5`,
      )
      .catch(() => []),
  ]);
  return {
    lastDay: Number(counts[0]?.total ?? 0),
    recent: recent.map((row) => ({
      action: row.action,
      actor: row.actor,
      at: new Date(row.created_at).toISOString(),
    })),
  };
}

interface RoutineRunRow {
  [key: string]: unknown;
  schedule_id: string;
  workflow_id: string;
  runs: number;
  no_change: number;
  useful: number;
  needed_human: number;
  failed: number;
  cost: number;
  last_useful_at: Date | string | null;
}

async function readRoutines(kernel: Kernel): Promise<{
  schedules: number;
  noChange: number;
  skippedOverlap: number;
  windowDays: number;
  scheduledRuns: number;
  usefulRuns: number;
  usefulRunRate: number | null;
  costUsd: number;
  costPerUsefulRun: number | null;
  noChangeShare: number | null;
  bySchedule: Array<{
    scheduleId: string;
    workflowId: string;
    runs: number;
    noChange: number;
    useful: number;
    usefulRunRate: number | null;
    costUsd: number;
    costPerUsefulRun: number | null;
    suggestion: 'keep' | 'slow_down' | 'event_trigger' | 'add_probe' | 'retire';
  }>;
}> {
  const [states, runs] = await Promise.all([
    kernel.database
      .query<{
        schedule_id: string;
        workflow_id: string;
        last_status: string | null;
        skipped_overlap: number;
      }>(
        `SELECT schedule_id, workflow_id, last_status, skipped_overlap
           FROM schedule_state ORDER BY schedule_id`,
      )
      .catch(() => []),
    kernel.database
      .query<RoutineRunRow>(
        `SELECT schedule_id, workflow_id,
                COUNT(*)::int AS runs,
                COUNT(*) FILTER (WHERE outcome = 'no_change')::int AS no_change,
                COUNT(*) FILTER (WHERE useful)::int AS useful,
                COUNT(*) FILTER (WHERE needed_human)::int AS needed_human,
                COUNT(*) FILTER (WHERE outcome = 'failed')::int AS failed,
                COALESCE(SUM(cost), 0)::float AS cost,
                MAX(started_at) FILTER (WHERE useful) AS last_useful_at
           FROM schedule_runs
          WHERE manual = false AND started_at > now() - interval '7 days'
          GROUP BY schedule_id, workflow_id
          ORDER BY schedule_id`,
      )
      .catch(() => []),
  ]);
  const bySchedule = new Map<
    string,
    {
      scheduleId: string;
      workflowId: string;
      runs: number;
      noChange: number;
      useful: number;
      usefulRunRate: number | null;
      costUsd: number;
      costPerUsefulRun: number | null;
      suggestion: 'keep' | 'slow_down' | 'event_trigger' | 'add_probe' | 'retire';
    }
  >();
  for (const state of states) {
    bySchedule.set(state.schedule_id, {
      scheduleId: state.schedule_id,
      workflowId: state.workflow_id,
      runs: 0,
      noChange: 0,
      useful: 0,
      usefulRunRate: null,
      costUsd: 0,
      costPerUsefulRun: null,
      suggestion: 'keep',
    });
  }
  let scheduledRuns = 0;
  let usefulRuns = 0;
  let noChangeRuns = 0;
  let costUsd = 0;
  for (const row of runs) {
    const receipt = routineReceipt({
      runs: Number(row.runs),
      noChange: Number(row.no_change),
      useful: Number(row.useful),
      neededHuman: Number(row.needed_human),
      repeatedFailures: Number(row.failed),
      skippedOverlap: 0,
      manualRuns: 0,
      cost: Number(row.cost),
      lastUsefulAt: row.last_useful_at ? new Date(row.last_useful_at).toISOString() : null,
      // A priced run is the honest signal that this routine calls a model.
      modelCalling: Number(row.cost) > 0,
      hasProbe: Number(row.no_change) > 0,
    });
    scheduledRuns += receipt.runs;
    usefulRuns += receipt.useful;
    noChangeRuns += receipt.noChange;
    costUsd += receipt.cost;
    bySchedule.set(row.schedule_id, {
      scheduleId: row.schedule_id,
      workflowId: row.workflow_id,
      runs: receipt.runs,
      noChange: receipt.noChange,
      useful: receipt.useful,
      usefulRunRate: Number(receipt.usefulRunRate.toFixed(3)),
      costUsd: Number(receipt.cost.toFixed(6)),
      costPerUsefulRun:
        receipt.costPerUsefulRun == null ? null : Number(receipt.costPerUsefulRun.toFixed(6)),
      suggestion: receipt.suggestion,
    });
  }
  return {
    schedules: states.length > 0 ? states.length : bySchedule.size,
    noChange: states.filter((state) => state.last_status === 'no_change').length,
    skippedOverlap: states.reduce((sum, state) => sum + Number(state.skipped_overlap ?? 0), 0),
    windowDays: 7,
    scheduledRuns,
    usefulRuns,
    usefulRunRate: scheduledRuns === 0 ? null : Number((usefulRuns / scheduledRuns).toFixed(3)),
    costUsd: Number(costUsd.toFixed(6)),
    costPerUsefulRun: usefulRuns === 0 ? null : Number((costUsd / usefulRuns).toFixed(6)),
    noChangeShare: scheduledRuns === 0 ? null : Number((noChangeRuns / scheduledRuns).toFixed(3)),
    bySchedule: [...bySchedule.values()].sort(
      (a, b) => b.runs - a.runs || a.scheduleId.localeCompare(b.scheduleId),
    ),
  };
}

interface TriggerCountRow {
  [key: string]: unknown;
  date: string;
  trigger: string;
  runs: number;
}

interface ReReadRow {
  [key: string]: unknown;
  average: number | null;
  over: number;
}

interface TopRunRow {
  [key: string]: unknown;
  run_id: string;
  workflow_id: string;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  cost: number;
}

const EMPTY_WAKE_UPS = {
  windowDays: 7,
  points: [] as Array<{ date: string; total: number; byTrigger: Record<string, number> }>,
  total: 0,
  probes: 0,
  averageReReadRatio: null as number | null,
  reReadThreshold: 50,
  runsAboveThreshold: 0,
  alert: false,
  topRuns: [] as Array<{
    runId: string;
    workflowId: string;
    tokensIn: number;
    tokensCached: number;
    tokensOut: number;
    reReadRatio: number | null;
    costUsd: number;
    contextParts: Array<{ source: string; tokens: number }>;
  }>,
};

/**
 * Wake-ups and re-reads (19.4/19.3): model-calling runs per day by trigger,
 * probes that ended `no_change`, and (tokensIn + tokensCached) ÷ tokensOut.
 * Only the ledger, run and schedule tables are read.
 */
async function readWakeUps(kernel: Kernel) {
  const [wakeRows, probeRows, reReadRows, topRows] = await Promise.all([
    kernel.database
      .query<TriggerCountRow>(
        `SELECT to_char(date_trunc('day', r.created_at), 'YYYY-MM-DD') AS date,
                r.trigger,
                COUNT(*)::int AS runs
           FROM workflow_runs r
          WHERE r.created_at > now() - interval '7 days'
            AND (EXISTS (SELECT 1 FROM cost_ledger c WHERE c.run_id = r.id)
              OR EXISTS (SELECT 1 FROM model_call_traces t WHERE t.run_id = r.id))
          GROUP BY 1, 2 ORDER BY 1`,
      )
      .catch(() => []),
    kernel.database
      .query<{ probes: number }>(
        `SELECT COUNT(*)::int AS probes FROM schedule_runs
          WHERE manual = false AND outcome = 'no_change'
            AND started_at > now() - interval '7 days'`,
      )
      .catch(() => []),
    kernel.database
      .query<ReReadRow>(
        `SELECT AVG(ratio)::float AS average,
                COUNT(*) FILTER (WHERE ratio > 50)::int AS over
           FROM (SELECT (SUM(tokens_in) + SUM(tokens_cached))::float
                        / NULLIF(SUM(tokens_out), 0) AS ratio
                   FROM cost_ledger
                  WHERE at > now() - interval '7 days' AND run_id IS NOT NULL
                  GROUP BY run_id) runs
          WHERE ratio IS NOT NULL`,
      )
      .catch(() => []),
    kernel.database
      .query<TopRunRow>(
        `SELECT c.run_id, COALESCE(r.workflow_id, 'unknown') AS workflow_id,
                COALESCE(SUM(c.tokens_in), 0)::int AS tokens_in,
                COALESCE(SUM(c.tokens_cached), 0)::int AS tokens_cached,
                COALESCE(SUM(c.tokens_out), 0)::int AS tokens_out,
                COALESCE(SUM(c.est_cost), 0)::float AS cost
           FROM cost_ledger c
           LEFT JOIN workflow_runs r ON r.id = c.run_id
          WHERE c.at > now() - interval '7 days' AND c.run_id IS NOT NULL
          GROUP BY c.run_id, r.workflow_id
          ORDER BY SUM(c.tokens_in + c.tokens_cached) DESC
          LIMIT 5`,
      )
      .catch(() => []),
  ]);

  const points = new Map<
    string,
    { date: string; total: number; byTrigger: Record<string, number> }
  >();
  for (const row of wakeRows) {
    const point = points.get(row.date) ?? { date: row.date, total: 0, byTrigger: {} };
    const count = Number(row.runs ?? 0);
    point.total += count;
    point.byTrigger[row.trigger] = (point.byTrigger[row.trigger] ?? 0) + count;
    points.set(row.date, point);
  }

  let contextParts = new Map<string, Array<{ source: string; tokens: number }>>();
  if (topRows.length > 0) {
    const parts = await kernel.database
      .query<{ run_id: string; included: Array<{ source?: string; tokens?: number }> | null }>(
        `SELECT run_id, payload->'context'->'included' AS included
           FROM agent_steps WHERE run_id = ANY($1::text[])`,
        [topRows.map((row) => row.run_id)],
      )
      .catch(() => [] as Array<{ run_id: string; included: null }>);
    contextParts = new Map(
      parts.map((row) => [
        row.run_id,
        (row.included ?? [])
          .map((item) => ({
            source: String(item.source ?? 'unknown'),
            tokens: Number(item.tokens ?? 0),
          }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 3),
      ]),
    );
  }

  const total = [...points.values()].reduce((sum, point) => sum + point.total, 0);
  const average = reReadRows[0]?.average;
  const runsAboveThreshold = Number(reReadRows[0]?.over ?? 0);
  return {
    ...EMPTY_WAKE_UPS,
    points: [...points.values()].sort((a, b) => a.date.localeCompare(b.date)),
    total,
    probes: Number(probeRows[0]?.probes ?? 0),
    averageReReadRatio: average == null ? null : Number(Number(average).toFixed(2)),
    runsAboveThreshold,
    alert: average != null && Number(average) > EMPTY_WAKE_UPS.reReadThreshold,
    topRuns: topRows.map((row) => {
      const tokensOut = Number(row.tokens_out);
      const ratio =
        tokensOut > 0 ? (Number(row.tokens_in) + Number(row.tokens_cached)) / tokensOut : null;
      return {
        runId: row.run_id,
        workflowId: row.workflow_id,
        tokensIn: Number(row.tokens_in),
        tokensCached: Number(row.tokens_cached),
        tokensOut,
        reReadRatio: ratio == null ? null : Number(ratio.toFixed(2)),
        costUsd: Number(Number(row.cost).toFixed(6)),
        contextParts: contextParts.get(row.run_id) ?? [],
      };
    }),
  };
}

/** Context packs and budget utilisation from agent steps and model traces. */
async function readContextPacks(kernel: Kernel) {
  const [rows, contexts] = await Promise.all([
    kernel.database
      .query<{ total_contexts: number }>(
        `SELECT COUNT(*)::int AS total_contexts FROM agent_steps
          WHERE at > now() - interval '7 days' AND payload ? 'context'`,
      )
      .catch(() => []),
    kernel.database
      .query<{
        calls: number;
        context_limit: number | null;
        avg_used: number | null;
        p95_used: number | null;
        avg_percent: number | null;
        p95_percent: number | null;
      }>(
        `SELECT COUNT(*)::int AS calls,
                MAX((trace->'context'->>'windowTokens')::numeric)::int AS context_limit,
                AVG((trace->'context'->>'usedTokens')::numeric)::float AS avg_used,
                percentile_cont(0.95) WITHIN GROUP
                  (ORDER BY (trace->'context'->>'usedTokens')::numeric)::float AS p95_used,
                AVG((trace->'context'->>'percent')::numeric)::float AS avg_percent,
                percentile_cont(0.95) WITHIN GROUP
                  (ORDER BY (trace->'context'->>'percent')::numeric)::float AS p95_percent
           FROM model_call_traces
          WHERE at > now() - interval '7 days' AND trace ? 'context'`,
      )
      .catch(() => []),
  ]);
  const totalContexts = Number(rows[0]?.total_contexts ?? 0);
  const measured = contexts[0];
  const calls = Number(measured?.calls ?? 0);
  const round = (value: number | null | undefined): number | null =>
    value == null ? null : Number(Number(value).toFixed(2));
  const pct = (value: number | null | undefined): number | null =>
    value == null ? null : Math.min(100, Math.max(0, Number(Number(value).toFixed(2))));
  return {
    available: totalContexts > 0 || calls > 0,
    totalContexts,
    callsMeasured: calls,
    contextLimit:
      measured?.context_limit == null ? null : Math.max(1, Number(measured.context_limit)),
    averageUsedTokens: round(measured?.avg_used),
    p95UsedTokens: round(measured?.p95_used),
    averagePercent: pct(measured?.avg_percent),
    p95Percent: pct(measured?.p95_percent),
  };
}

interface RoutingTraceRow {
  [key: string]: unknown;
  provider: string;
  model: string;
  reason: string;
  calls: number;
  fallbacks: number;
  escalations: number;
  repairs: number;
}

/** Tier labels from the runtime inventory; never inferred from a model name. */
function runtimeTiers(kernel: Kernel): Map<string, string> {
  const capabilities = kernel.config.capabilities as Record<string, unknown>;
  const rows = [
    ...(Array.isArray(capabilities.runtimes) ? (capabilities.runtimes as unknown[]) : []),
    capabilities.chatModel,
    capabilities.generator,
  ].filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
  const tiers = new Map<string, string>();
  for (const row of rows) {
    const adapter = String(row.adapter ?? '');
    const model = String(row.model ?? '');
    if (!adapter || !model) continue;
    const tier = typeof row.tier === 'string' && row.tier.length > 0 ? row.tier : 'unclassified';
    tiers.set(`${adapter}:${model}`, tier);
  }
  return tiers;
}

/** Model routing tiers, reasons, fallbacks and escalations from traces. */
async function readRouting(kernel: Kernel) {
  const [rows, costs] = await Promise.all([
    kernel.database
      .query<RoutingTraceRow>(
        `SELECT COALESCE(trace->>'provider', 'unknown') AS provider,
                COALESCE(trace->>'modelName', 'unknown') AS model,
                COALESCE(trace->>'routingReason', 'unknown') AS reason,
                COUNT(*)::int AS calls,
                COUNT(*) FILTER
                  (WHERE COALESCE(trace->>'fallbackUsed', 'none') <> 'none')::int AS fallbacks,
                COUNT(*) FILTER
                  (WHERE trace->>'fallbackUsed' IN ('fallback_model', 'fallback_edge'))::int AS escalations,
                COUNT(*) FILTER (WHERE trace->>'fallbackUsed' = 'repair')::int AS repairs
           FROM model_call_traces
          WHERE at > now() - interval '7 days'
          GROUP BY 1, 2, 3`,
      )
      .catch(() => []),
    kernel.database
      .query<{ provider: string; model: string; cost: number }>(
        `SELECT provider, model, COALESCE(SUM(est_cost), 0)::float AS cost
           FROM cost_ledger WHERE at > now() - interval '7 days'
          GROUP BY provider, model`,
      )
      .catch(() => []),
  ]);
  const tiers = runtimeTiers(kernel);
  const costByModel = new Map(costs.map((row) => [`${row.provider}:${row.model}`, row.cost]));
  const byModel = new Map<
    string,
    { provider: string; model: string; tier: string; calls: number; costUsd: number }
  >();
  const byReason = new Map<string, number>();
  const byTier: Record<string, number> = {};
  let calls = 0;
  let fallbacks = 0;
  let escalations = 0;
  let repairs = 0;
  for (const row of rows) {
    const key = `${row.provider}:${row.model}`;
    const tier = tiers.get(key) ?? 'unclassified';
    const entry = byModel.get(key) ?? {
      provider: row.provider,
      model: row.model,
      tier,
      calls: 0,
      costUsd: Number(costByModel.get(key) ?? 0),
    };
    entry.calls += Number(row.calls);
    byModel.set(key, entry);
    byTier[tier] = (byTier[tier] ?? 0) + Number(row.calls);
    byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + Number(row.calls));
    calls += Number(row.calls);
    fallbacks += Number(row.fallbacks);
    escalations += Number(row.escalations);
    repairs += Number(row.repairs);
  }
  return {
    windowDays: 7,
    calls,
    byModel: [...byModel.values()].sort((a, b) => b.calls - a.calls),
    byTier,
    byReason: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, calls: count }))
      .sort((a, b) => b.calls - a.calls),
    escalations,
    fallbacks,
    repairs,
  };
}

/** Cache hit rates from the generation decision records and the ledger. */
async function readCaches(kernel: Kernel) {
  type RoutingPrices = Record<string, { inputPer1k?: number }>;
  const routing = (kernel.config as typeof kernel.config & { routing?: { prices?: RoutingPrices } })
    .routing;
  const [generationRows, promptRows] = await Promise.all([
    kernel.database
      .query<{ lookups: number; hits: number }>(
        `SELECT COUNT(*)::int AS lookups,
                COUNT(*) FILTER
                  (WHERE COALESCE((d.deterministic->>'cacheHit')::boolean, false))::int AS hits
           FROM decision_records d
           JOIN stage_runs s ON s.id = d.stage_run_id
          WHERE s.kind = 'ai.generate'
            AND d.created_at > now() - interval '7 days'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ provider: string; model: string; cached: number; input: number }>(
        `SELECT provider, model,
                COALESCE(SUM(tokens_cached), 0)::int AS cached,
                COALESCE(SUM(tokens_in), 0)::int AS input
           FROM cost_ledger
          WHERE at > now() - interval '7 days'
          GROUP BY provider, model`,
      )
      .catch(() => []),
  ]);
  const lookups = Number(generationRows[0]?.lookups ?? 0);
  const hits = Number(generationRows[0]?.hits ?? 0);
  let tokensCached = 0;
  let tokensIn = 0;
  let savedUsd = 0;
  let priced = false;
  let everyCachedRowPriced = true;
  for (const row of promptRows) {
    const cached = Number(row.cached);
    tokensCached += cached;
    tokensIn += Number(row.input);
    const price = routing?.prices?.[`${row.provider}:${row.model}`];
    if (cached > 0) {
      if (price?.inputPer1k == null) everyCachedRowPriced = false;
      else {
        priced = true;
        savedUsd += (cached / 1_000) * price.inputPer1k;
      }
    }
  }
  return {
    windowDays: 7,
    generation: {
      available: lookups > 0,
      lookups,
      hits,
      hitRate: lookups === 0 ? null : Number((hits / lookups).toFixed(3)),
    },
    prompt: {
      tokensCached,
      tokensIn,
      hitRate: tokensIn === 0 ? null : Number(Math.min(1, tokensCached / tokensIn).toFixed(3)),
      savedUsd: priced && everyCachedRowPriced ? Number(savedUsd.toFixed(6)) : null,
      priced,
    },
    retrieval: { available: false },
  };
}

async function readTaskCompletion(kernel: Kernel) {
  const rows = await kernel.database
    .query<{
      started: number;
      succeeded: number;
      failed: number;
      cancelled: number;
      awaiting: number;
      active: number;
    }>(
      `SELECT COUNT(*)::int AS started,
              COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
              COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
              COUNT(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
              COUNT(*) FILTER (WHERE status = 'AWAITING')::int AS awaiting,
              COUNT(*) FILTER (WHERE status IN ('PENDING', 'RUNNING'))::int AS active
         FROM workflow_runs WHERE created_at > now() - interval '7 days'`,
    )
    .catch(() => []);
  const row = rows[0];
  const started = Number(row?.started ?? 0);
  return {
    windowDays: 7,
    started,
    succeeded: Number(row?.succeeded ?? 0),
    failed: Number(row?.failed ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    awaiting: Number(row?.awaiting ?? 0),
    active: Number(row?.active ?? 0),
    rate: started === 0 ? null : Number((Number(row?.succeeded ?? 0) / started).toFixed(3)),
  };
}

async function readUnitCosts(kernel: Kernel) {
  const [ledger, steps, completed] = await Promise.all([
    kernel.database
      .query<{ cost: number; tokens: number }>(
        `SELECT COALESCE(SUM(est_cost), 0)::float AS cost,
                COALESCE(SUM(tokens_in + tokens_out), 0)::int AS tokens
           FROM cost_ledger WHERE at > now() - interval '7 days'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ steps: number }>(
        `SELECT COUNT(*)::int AS steps FROM stage_runs
          WHERE created_at > now() - interval '7 days'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ completed: number }>(
        `SELECT COUNT(*)::int AS completed FROM workflow_runs
          WHERE status = 'SUCCEEDED' AND created_at > now() - interval '7 days'`,
      )
      .catch(() => []),
  ]);
  const cost = Number(ledger[0]?.cost ?? 0);
  const tokens = Number(ledger[0]?.tokens ?? 0);
  const stepCount = Number(steps[0]?.steps ?? 0);
  const completedRuns = Number(completed[0]?.completed ?? 0);
  const divide = (total: number, count: number): number | null =>
    count === 0 ? null : Number((total / count).toFixed(9));
  return {
    windowDays: 7,
    costUsd: Number(cost.toFixed(6)),
    tokens,
    steps: stepCount,
    completedRuns,
    costPerTokenUsd: divide(cost, tokens),
    costPerStepUsd: divide(cost, stepCount),
    costPerCompletedRunUsd: divide(cost, completedRuns),
  };
}

async function readSchemaValidity(kernel: Kernel) {
  const rows = await kernel.database
    .query<{ calls: number; valid: number }>(
      `SELECT COUNT(*)::int AS calls,
              COUNT(*) FILTER
                (WHERE COALESCE((trace->>'schemaValidFirstTry')::boolean, false))::int AS valid
         FROM model_call_traces
        WHERE at > now() - interval '7 days' AND trace ? 'schemaValidFirstTry'`,
    )
    .catch(() => []);
  const calls = Number(rows[0]?.calls ?? 0);
  const valid = Number(rows[0]?.valid ?? 0);
  return {
    available: calls > 0,
    calls,
    validFirstTry: valid,
    rate: calls === 0 ? null : Number((valid / calls).toFixed(3)),
  };
}

async function readToolCalls(kernel: Kernel) {
  const rows = await kernel.database
    .query<{ calls: number; ok: number; failed: number; blocked: number }>(
      `SELECT COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE element->>'status' = 'ok')::int AS ok,
              COUNT(*) FILTER (WHERE element->>'status' = 'error')::int AS failed,
              COUNT(*) FILTER (WHERE element->>'status' = 'blocked')::int AS blocked
         FROM model_call_traces t
         CROSS JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(t.trace->'toolCalls') = 'array'
                THEN t.trace->'toolCalls' ELSE '[]'::jsonb END
         ) AS element
        WHERE t.at > now() - interval '7 days'`,
    )
    .catch(() => []);
  const calls = Number(rows[0]?.calls ?? 0);
  const ok = Number(rows[0]?.ok ?? 0);
  const blocked = Number(rows[0]?.blocked ?? 0);
  const eligible = calls - blocked;
  return {
    available: calls > 0,
    calls,
    ok,
    failed: Number(rows[0]?.failed ?? 0),
    blocked,
    successRate: eligible === 0 ? null : Number((ok / eligible).toFixed(3)),
  };
}

async function readRetrievalQuality(kernel: Kernel) {
  const rows = await kernel.database
    .query<{ retrievals: number; hits: number }>(
      `WITH retrievals AS (
         SELECT d.run_id, COALESCE((d.evidence->>'selectedChunks')::int, 0) AS selected
           FROM decision_records d
           JOIN stage_runs s ON s.id = d.stage_run_id
          WHERE s.kind = 'ai.retrieve'
            AND d.created_at > now() - interval '7 days'
       ),
       cited AS (
         SELECT d.run_id,
                bool_or(
                  COALESCE((d.evidence->'grounding'->>'cited')::boolean, false)
                  OR jsonb_array_length(COALESCE(d.evidence->'citations', '[]'::jsonb)) > 0
                ) AS cited
           FROM decision_records d
           JOIN stage_runs s ON s.id = d.stage_run_id
          WHERE s.kind IN ('ai.finalize_answer', 'chat.deliver')
            AND d.created_at > now() - interval '7 days'
          GROUP BY d.run_id
       )
       SELECT COUNT(*)::int AS retrievals,
              COUNT(*) FILTER
                (WHERE r.selected > 0 AND COALESCE(c.cited, false))::int AS hits
         FROM retrievals r LEFT JOIN cited c ON c.run_id = r.run_id`,
    )
    .catch(() => []);
  const retrievals = Number(rows[0]?.retrievals ?? 0);
  const hits = Number(rows[0]?.hits ?? 0);
  return {
    available: retrievals > 0,
    retrievals,
    hits,
    hitRate: retrievals === 0 ? null : Number((hits / retrievals).toFixed(3)),
  };
}

/** Same deterministic rules as `GET /api/v1/system/alerts`. */
async function readAlerts(kernel: Kernel) {
  const [runs, queue, approvals, egress, tokens, evalReports] = await Promise.all([
    kernel.database
      .query<{ total: number; failed: number }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed
           FROM workflow_runs WHERE created_at > now() - interval '5 minutes'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ pending: number }>(
        `SELECT COUNT(*)::int AS pending FROM queue_jobs WHERE status = 'pending'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ stuck: number }>(
        `SELECT COUNT(*)::int AS stuck FROM approvals
          WHERE status = 'pending' AND created_at < now() - interval '1 hour'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ denied: number }>(
        `SELECT COUNT(*)::int AS denied FROM audit_events
          WHERE action = 'egress.denied' AND created_at > now() - interval '1 hour'`,
      )
      .catch(() => []),
    kernel.database
      .query<{ provider: string; tokens: number }>(
        `SELECT provider, SUM(tokens_in + tokens_out)::int AS tokens
           FROM cost_ledger WHERE at >= date_trunc('day', now()) GROUP BY provider`,
      )
      .catch(() => []),
    kernel.database
      .query<{ metrics: Record<string, unknown> | null; passes: boolean }>(
        `SELECT metrics, passes FROM eval_reports
          WHERE generated_at > now() - interval '30 days'
          ORDER BY generated_at DESC LIMIT 20`,
      )
      .catch(() => []),
  ]);
  const total = Number(runs[0]?.total ?? 0);
  const failed = Number(runs[0]?.failed ?? 0);
  const budgets = kernel.config.hosted?.budgets ?? {};
  const burns = tokens
    .map((row) => {
      const cap = budgets[row.provider]?.dailyTokens;
      return cap ? row.tokens / cap : undefined;
    })
    .filter((value): value is number => value !== undefined);
  return evaluateAlerts({
    errorRate: total === 0 ? 0 : failed / total,
    queueDepth: Number(queue[0]?.pending ?? 0),
    stuckApprovals: Number(approvals[0]?.stuck ?? 0),
    egressDenials: Number(egress[0]?.denied ?? 0),
    ...(burns.length > 0 ? { budgetBurn: Math.max(...burns) } : {}),
    drift: detectEvalDrift(evalReports),
  });
}

async function readCoordination(
  kernel: Kernel,
): Promise<{ available: boolean; overhead?: number; threshold: number; alert?: boolean }> {
  const threshold = 0.3;
  const rows = await kernel.database
    .query<{ task: string; tokens: number }>(
      `SELECT task, COALESCE(SUM(tokens_in + tokens_out), 0)::int AS tokens
         FROM cost_ledger
        WHERE at > now() - interval '7 days'
        GROUP BY task`,
    )
    .catch(() => []);
  if (rows.length === 0) return { available: false, threshold };
  let supervisionTokens = 0;
  let handoffTokens = 0;
  let reviewTokens = 0;
  let taskTokens = 0;
  for (const row of rows) {
    const task = row.task.toLowerCase();
    const tokens = Number(row.tokens);
    if (task.includes('supervis')) supervisionTokens += tokens;
    else if (task.includes('handoff')) handoffTokens += tokens;
    else if (task.includes('review')) reviewTokens += tokens;
    else taskTokens += tokens;
  }
  const result = coordinationOverhead(
    { supervisionTokens, handoffTokens, reviewTokens, taskTokens },
    threshold,
  );
  return { available: true, overhead: result.overhead, threshold, alert: result.alert };
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
  const [definitions, usage, statuses, series, runtimeRows, pausedRows, failureRows] =
    await Promise.all([
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
      kernel.database
        .query<{ agent_id: string; running: number; succeeded: number; failed: number }>(
          `SELECT c.agent_id,
                  COUNT(DISTINCT c.run_id) FILTER
                    (WHERE r.status IN ('PENDING','RUNNING','AWAITING'))::int AS running,
                  COUNT(DISTINCT c.run_id) FILTER (WHERE r.status = 'SUCCEEDED')::int AS succeeded,
                  COUNT(DISTINCT c.run_id) FILTER (WHERE r.status = 'FAILED')::int AS failed
             FROM cost_ledger c
             JOIN workflow_runs r ON r.id = c.run_id
            WHERE c.agent_id IS NOT NULL AND c.at > now() - interval '24 hours'
            GROUP BY c.agent_id`,
        )
        .catch(() => []),
      kernel.database
        .query<{ agent_id: string; bucket: string; runs: number; tokens: number; cost: number }>(
          `SELECT agent_id,
                  to_char(date_trunc('hour', at), 'YYYY-MM-DD"T"HH24:00') AS bucket,
                  COUNT(DISTINCT run_id)::int AS runs,
                  COALESCE(SUM(tokens_in + tokens_out), 0)::int AS tokens,
                  COALESCE(SUM(est_cost), 0)::float AS cost
             FROM cost_ledger
            WHERE agent_id IS NOT NULL AND at > now() - interval '24 hours'
            GROUP BY 1, 2 ORDER BY 2`,
        )
        .catch(() => []),
      kernel.database
        .query<{
          agent_id: string;
          state: string | null;
          current_step: number | null;
          context: {
            windowTokens?: number;
            usedTokens?: number;
            percent?: number;
          } | null;
          at: Date | string;
        }>(
          `SELECT DISTINCT ON (agent_id) agent_id, state, current_step, context, at
             FROM (
               SELECT COALESCE(r.input->>'agentId', r.input->'definition'->>'id') AS agent_id,
                      c.state->>'status' AS state,
                      NULLIF(c.state->>'step', '')::int AS current_step,
                      t.trace->'context' AS context,
                      c.updated_at AS at
                 FROM agent_checkpoints c
                 JOIN workflow_runs r ON r.id = c.run_id
                 LEFT JOIN LATERAL (
                   SELECT trace FROM model_call_traces
                    WHERE run_id = c.run_id ORDER BY at DESC LIMIT 1
                 ) t ON true
                WHERE COALESCE(r.input->>'agentId', r.input->'definition'->>'id') IS NOT NULL
             ) latest
            ORDER BY agent_id, at DESC`,
        )
        .catch(() => []),
      kernel.database
        .query<{ scope_id: string }>(
          `SELECT scope_id FROM shared_state
            WHERE scope_type = 'agent' AND key = 'paused'
              AND COALESCE((value->>'paused')::boolean, false)`,
        )
        .catch(() => []),
      kernel.database
        .query<{ agent_id: string; failures: number }>(
          `SELECT COALESCE(r.input->>'agentId', r.input->'definition'->>'id') AS agent_id,
                  COUNT(*)::int AS failures
             FROM agent_steps s
             JOIN workflow_runs r ON r.id = s.run_id
            WHERE s.decision = 'fail' AND s.at > now() - interval '24 hours'
            GROUP BY 1`,
        )
        .catch(() => []),
    ]);
  const byAgent = new Map(usage.map((row) => [row.agent_id, row]));
  const byStatus = new Map(statuses.map((row) => [row.agent_id, row]));
  const byRuntime = new Map(runtimeRows.map((row) => [row.agent_id, row]));
  const paused = new Set(pausedRows.map((row) => row.scope_id));
  const failures = new Map(failureRows.map((row) => [row.agent_id, Number(row.failures)]));
  const seriesByAgent = new Map<string, DashboardAgent['series']>();
  for (const point of series) {
    seriesByAgent.set(point.agent_id, [
      ...(seriesByAgent.get(point.agent_id) ?? []),
      {
        bucket: point.bucket,
        runs: count(point.runs),
        tokens: count(point.tokens),
        cost: Number(point.cost ?? 0),
      },
    ]);
  }
  const mapStatus = (
    agentId: string,
    state: string | null | undefined,
    activeRuns: number,
  ): NonNullable<DashboardAgent['status']> => {
    if (paused.has(agentId)) return 'paused';
    if (state === 'running') return 'running';
    if (state === 'awaiting_human') return 'awaiting_human';
    if (state === 'done') return 'done';
    if (state === 'failed') return 'failed';
    if (state === 'paused') return 'paused';
    return activeRuns > 0 ? 'running' : 'idle';
  };
  return definitions.map((definition, index) => {
    const used = byAgent.get(definition.id);
    const usageStatus = byStatus.get(definition.id);
    const runtime = byRuntime.get(definition.id);
    const recentFailures = failures.get(definition.id) ?? 0;
    const context = runtime?.context ?? null;
    const contextPercent =
      context?.percent == null
        ? null
        : Math.min(100, Math.max(0, Number(Number(context.percent).toFixed(1))));
    const contextUsed =
      context?.usedTokens == null ? null : Number(Math.max(0, Number(context.usedTokens)));
    const contextLimit =
      context?.windowTokens == null ? null : Math.max(1, Number(context.windowTokens));
    const stepLimit = Number(definition.definition.maxSteps ?? 10);
    const running = count(usageStatus?.running);
    return {
      id: definition.id,
      displayName: definition.display_name,
      color:
        (definition.definition.color as string | undefined) ??
        (AGENT_PALETTE[index % AGENT_PALETTE.length] as string),
      running,
      runs: count(used?.runs),
      tokens: count(used?.tokens),
      cost: Number(used?.cost ?? 0),
      succeeded: count(usageStatus?.succeeded),
      failed: count(usageStatus?.failed),
      series: seriesByAgent.get(definition.id) ?? [],
      status: mapStatus(definition.id, runtime?.state, running),
      currentStep: runtime?.current_step == null ? null : Number(runtime.current_step),
      stepLimit: Number.isFinite(stepLimit) && stepLimit > 0 ? stepLimit : null,
      contextPercent,
      contextUsedTokens: contextUsed,
      contextLimitTokens: contextLimit,
      watchdog: {
        paused: paused.has(definition.id),
        recentFailures,
        flag: paused.has(definition.id)
          ? 'paused'
          : recentFailures >= 3
            ? 'repeated_failures'
            : null,
      },
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

  async function buildDashboard(): Promise<SystemDashboard> {
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
    const flags =
      database === 'down'
        ? { total: 0, runs: 0, rate: 0 }
        : await readFlags(kernel).catch(() => ({ total: 0, runs: 0, rate: 0 }));
    const coordination =
      database === 'down'
        ? { available: false, threshold: 0.3 }
        : await readCoordination(kernel).catch(() => ({ available: false, threshold: 0.3 }));
    const suggestions =
      database === 'down' ? [] : await readPipelineSuggestions(kernel.database).catch(() => []);
    const routines =
      database === 'down'
        ? {
            schedules: 0,
            noChange: 0,
            skippedOverlap: 0,
            windowDays: 7,
            scheduledRuns: 0,
            usefulRuns: 0,
            usefulRunRate: null,
            costUsd: 0,
            costPerUsefulRun: null,
            noChangeShare: null,
            bySchedule: [],
          }
        : await readRoutines(kernel).catch(() => ({
            schedules: 0,
            noChange: 0,
            skippedOverlap: 0,
            windowDays: 7,
            scheduledRuns: 0,
            usefulRuns: 0,
            usefulRunRate: null,
            costUsd: 0,
            costPerUsefulRun: null,
            noChangeShare: null,
            bySchedule: [],
          }));
    const quality =
      database === 'down'
        ? {
            reports: 0,
            passes: 0,
            passRate: null,
            drift: null,
            refusalRate: null,
            escalationRate: null,
            autoResolveRate: null,
          }
        : await readQuality(kernel).catch(() => ({
            reports: 0,
            passes: 0,
            passRate: null,
            drift: null,
            refusalRate: null,
            escalationRate: null,
            autoResolveRate: null,
          }));
    const audit =
      database === 'down'
        ? { lastDay: 0, recent: [] }
        : await readAudit(kernel).catch(() => ({ lastDay: 0, recent: [] }));
    const trajectory =
      database === 'down'
        ? EMPTY_TRAJECTORY
        : await readTrajectoryQuality(kernel.database).catch(() => EMPTY_TRAJECTORY);

    const providers =
      database === 'down' ? [] : await kernel.readDashboardProviders().catch(() => []);
    const providerValue = <T>(key: string): T | undefined => {
      for (const provider of providers) {
        if (provider[key] !== undefined) return provider[key] as T;
      }
      return undefined;
    };
    const context = providerValue('context') ?? null;
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
    const restarts =
      database === 'down'
        ? 0
        : await countRestarts(kernel.database, new Date(Date.now() - 24 * 60 * 60 * 1000)).catch(
            () => 0,
          );
    const uptime = { ...summarizeUptime(uptimeRows, Math.floor(process.uptime())), restarts };
    const storage = await readStorage(kernel.database, {
      blobRoot:
        process.env.TRIAGEAI_BLOB_ROOT ??
        resolve(process.env.TRIAGEAI_DATA_DIR ?? process.cwd(), 'data/blobs'),
      pluginsRoot: process.env.TRIAGEAI_PLUGINS_DIR,
      modelRoot: process.env.TRIAGEAI_MODEL_DIR ?? '/models',
      logRoot: process.env.TRIAGEAI_LOG_DIR,
    }).catch(() => null);

    const [
      wakeUps,
      contextPacks,
      routing,
      caches,
      taskCompletion,
      unitCosts,
      schemaValidity,
      toolCalls,
      retrieval,
      alerts,
    ] =
      database === 'down'
        ? [
            EMPTY_WAKE_UPS,
            {
              available: false,
              totalContexts: 0,
              callsMeasured: 0,
              contextLimit: null,
              averageUsedTokens: null,
              p95UsedTokens: null,
              averagePercent: null,
              p95Percent: null,
            },
            {
              windowDays: 7,
              calls: 0,
              byModel: [],
              byTier: {},
              byReason: [],
              escalations: 0,
              fallbacks: 0,
              repairs: 0,
            },
            {
              windowDays: 7,
              generation: { available: false, lookups: 0, hits: 0, hitRate: null },
              prompt: {
                tokensCached: 0,
                tokensIn: 0,
                hitRate: null,
                savedUsd: null,
                priced: false,
              },
              retrieval: { available: false },
            },
            {
              windowDays: 7,
              started: 0,
              succeeded: 0,
              failed: 0,
              cancelled: 0,
              awaiting: 0,
              active: 0,
              rate: null,
            },
            {
              windowDays: 7,
              costUsd: 0,
              tokens: 0,
              steps: 0,
              completedRuns: 0,
              costPerTokenUsd: null,
              costPerStepUsd: null,
              costPerCompletedRunUsd: null,
            },
            { available: false, calls: 0, validFirstTry: 0, rate: null },
            { available: false, calls: 0, ok: 0, failed: 0, blocked: 0, successRate: null },
            { available: false, retrievals: 0, hits: 0, hitRate: null },
            [],
          ]
        : await Promise.all([
            readWakeUps(kernel).catch(() => EMPTY_WAKE_UPS),
            readContextPacks(kernel).catch(() => ({
              available: false,
              totalContexts: 0,
              callsMeasured: 0,
              contextLimit: null,
              averageUsedTokens: null,
              p95UsedTokens: null,
              averagePercent: null,
              p95Percent: null,
            })),
            readRouting(kernel).catch(() => ({
              windowDays: 7,
              calls: 0,
              byModel: [],
              byTier: {},
              byReason: [],
              escalations: 0,
              fallbacks: 0,
              repairs: 0,
            })),
            readCaches(kernel).catch(() => ({
              windowDays: 7,
              generation: { available: false, lookups: 0, hits: 0, hitRate: null },
              prompt: {
                tokensCached: 0,
                tokensIn: 0,
                hitRate: null,
                savedUsd: null,
                priced: false,
              },
              retrieval: { available: false },
            })),
            readTaskCompletion(kernel).catch(() => ({
              windowDays: 7,
              started: 0,
              succeeded: 0,
              failed: 0,
              cancelled: 0,
              awaiting: 0,
              active: 0,
              rate: null,
            })),
            readUnitCosts(kernel).catch(() => ({
              windowDays: 7,
              costUsd: 0,
              tokens: 0,
              steps: 0,
              completedRuns: 0,
              costPerTokenUsd: null,
              costPerStepUsd: null,
              costPerCompletedRunUsd: null,
            })),
            readSchemaValidity(kernel).catch(() => ({
              available: false,
              calls: 0,
              validFirstTry: 0,
              rate: null,
            })),
            readToolCalls(kernel).catch(() => ({
              available: false,
              calls: 0,
              ok: 0,
              failed: 0,
              blocked: 0,
              successRate: null,
            })),
            readRetrievalQuality(kernel).catch(() => ({
              available: false,
              retrievals: 0,
              hits: 0,
              hitRate: null,
            })),
            readAlerts(kernel).catch(() => []),
          ]);

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
      flags,
      coordination,
      suggestions,
      context,
      routines,
      quality,
      audit,
      ...costAndEfficiency,
      modelUsage,
      modelRuntimes,
      llmDisabled: controls.llmDisabled,
      uptime,
      storage,
      wakeUps,
      contextPacks,
      routing,
      caches,
      taskCompletion,
      unitCosts,
      schemaValidity,
      toolCalls,
      retrieval,
      alerts,
      trajectory,
    });
  }

  // 19.T5: the aggregate is cached for 5 s per process. `?fresh=1` bypasses
  // (tests and the refresh button), and NODE_ENV=test bypasses by default so
  // fixtures that write between requests keep their existing semantics; set
  // TRIAGEAI_DASHBOARD_CACHE=1 to exercise the cache in a test.
  let responseCacheEntry: { key: string; at: number; value: SystemDashboard } | null = null;
  let responseCacheHits = 0;
  let responseCacheMisses = 0;
  const responseCacheEnabled = (): boolean =>
    process.env.NODE_ENV !== 'test' || process.env.TRIAGEAI_DASHBOARD_CACHE === '1';
  const responseCacheStats = (hit: boolean, ageMs: number) => {
    const total = responseCacheHits + responseCacheMisses;
    return {
      hit,
      ageMs,
      hits: responseCacheHits,
      misses: responseCacheMisses,
      hitRate: total === 0 ? 0 : responseCacheHits / total,
    };
  };

  app.get('/api/v1/system/dashboard', async (request) => {
    const query = z.object({ fresh: z.enum(['0', '1']).optional() }).parse(request.query ?? {});
    const cacheKey = JSON.stringify(kernel.manifest().modules);
    if (responseCacheEnabled() && query.fresh !== '1') {
      const entry = responseCacheEntry;
      if (entry && entry.key === cacheKey && Date.now() - entry.at < 5_000) {
        responseCacheHits += 1;
        return SystemDashboardSchema.parse({
          ...entry.value,
          responseCache: responseCacheStats(true, Date.now() - entry.at),
        });
      }
    }
    if (responseCacheEnabled()) responseCacheMisses += 1;
    const payload = await buildDashboard();
    if (responseCacheEnabled()) {
      responseCacheEntry = { key: cacheKey, at: Date.now(), value: payload };
    }
    return SystemDashboardSchema.parse({
      ...payload,
      responseCache: responseCacheStats(false, 0),
    });
  });
}
