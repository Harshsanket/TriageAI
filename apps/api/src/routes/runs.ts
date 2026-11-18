/**
 * Host-owned run inspector surface (Phase 2).
 *
 * Deviation from DEVELOPMENT_PLAN §Phase 2, which names a `workflows-ui`
 * module: modules may only read through `KernelContext`, and run/stage/decision
 * tables are kernel-owned, so the read model + cancel API live in the host
 * under `/api/v1/system/*` (recorded in ADR-0011).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Kernel } from '@triageai/kernel';
import { notFound } from '@triageai/kernel';
import {
  DecisionRecordDtoSchema,
  RunDailySummarySchema,
  RunDtoSchema,
  StageRunDtoSchema,
} from '@triageai/contracts';

import { writeAudit } from '../services/audit.js';
import { ensureTrajectory } from '../services/trajectory.js';

interface RunRow {
  [key: string]: unknown;
  id: string;
  workflow_id: string;
  workflow_version: string;
  trigger: string;
  status: string;
  input: unknown;
  output: Record<string, unknown> | null;
  error: string | null;
  pinned_versions?: Record<string, unknown> | null;
  created_at: Date | string;
  finished_at: Date | string | null;
}

interface StageRow {
  [key: string]: unknown;
  id: string;
  run_id: string;
  stage_id: string;
  kind: string;
  status: string;
  attempts: number;
  output: unknown;
  error: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

interface DecisionRow {
  [key: string]: unknown;
  id: string;
  run_id: string;
  stage_run_id: string;
  workflow_id: string;
  module_id: string;
  module_version: string;
  evidence: Record<string, unknown> | null;
  deterministic: Record<string, unknown> | null;
  timings: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  fallback: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
  created_at: Date | string;
}

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

function toRunDto(row: RunRow) {
  return RunDtoSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    trigger: row.trigger,
    status: row.status,
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: iso(row.finished_at),
  });
}

export function registerRunRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/runs', async (request) => {
    const query = request.query as { workflowId?: string; limit?: string; status?: string };
    const rawLimit = Number(query.limit ?? 25);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 25;
    const rows = (await kernel.database.query(
      `SELECT id, workflow_id, workflow_version, trigger, status, input, output, error, created_at, finished_at
       FROM workflow_runs
       WHERE ($1::text IS NULL OR workflow_id = $1)
         AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [query.workflowId ?? null, query.status ?? null, limit],
    )) as unknown as RunRow[];
    return rows.map(toRunDto);
  });

  app.get('/api/v1/system/runs/daily', async (request) => {
    const query = request.query as { days?: string };
    const requested = Number(query.days ?? 14);
    const days = Number.isFinite(requested) ? Math.min(Math.max(1, requested), 90) : 14;
    const rows = await kernel.database.query<{
      date: string;
      total_runs: number;
      succeeded: number;
      failed: number;
      workflows: string[];
    }>(
      `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS total_runs,
              COUNT(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
              COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
              array_agg(DISTINCT workflow_id) AS workflows
         FROM workflow_runs
        WHERE created_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY 1 DESC`,
      [days],
    );
    const flags = await kernel.database.query<{
      date: string;
      sensitive_runs: number;
      data_touched_runs: number;
    }>(
      `SELECT to_char(r.created_at::date, 'YYYY-MM-DD') AS date,
              COUNT(DISTINCT r.id) FILTER (
                WHERE d.evidence::text ~* '"(sensitivity|dataClass)"[[:space:]]*:[[:space:]]*"(restricted|secret)"'
              )::int AS sensitive_runs,
              COUNT(DISTINCT r.id) FILTER (
                WHERE d.evidence->>'kind' IN ('tool', 'tool_call', 'data_access')
                   OR d.evidence ? 'tool'
                   OR d.evidence ? 'dataClass'
                   OR d.deterministic ? 'dataClass'
              )::int AS data_touched_runs
         FROM workflow_runs r
         LEFT JOIN decision_records d ON d.run_id = r.id
        WHERE r.created_at > now() - ($1 || ' days')::interval
        GROUP BY 1`,
      [days],
    );
    const byDate = new Map(flags.map((row) => [row.date, row]));
    return RunDailySummarySchema.parse({
      days: rows.map((row) => ({
        date: row.date,
        totalRuns: Number(row.total_runs),
        workflows: row.workflows ?? [],
        succeeded: Number(row.succeeded),
        failed: Number(row.failed),
        sensitiveRuns: Number(byDate.get(row.date)?.sensitive_runs ?? 0),
        dataTouchedRuns: Number(byDate.get(row.date)?.data_touched_runs ?? 0),
      })),
    });
  });

  app.get('/api/v1/system/runs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const runs = (await kernel.database.query(
      `SELECT id, workflow_id, workflow_version, trigger, status, input, output, error,
              pinned_versions, created_at, finished_at
       FROM workflow_runs WHERE id = $1`,
      [id],
    )) as unknown as RunRow[];
    const run = runs[0];
    if (!run) throw notFound(`run ${id} not found`, { runId: id });

    const stages = (await kernel.database.query(
      `SELECT id, run_id, stage_id, kind, status, attempts, output, error, started_at, finished_at
       FROM stage_runs WHERE run_id = $1 ORDER BY created_at, stage_id`,
      [id],
    )) as unknown as StageRow[];

    const decisions = (await kernel.database.query(
      `SELECT id, run_id, stage_run_id, workflow_id, module_id, module_version,
              evidence, deterministic, timings, error, fallback, outcome, created_at
       FROM decision_records WHERE run_id = $1 ORDER BY created_at`,
      [id],
    )) as unknown as DecisionRow[];

    // 18.T24: trajectory + step scores are computed once for a finished run and
    // then served from `trajectory_metrics` (documented on-demand path).
    const trajectory = await ensureTrajectory(kernel, id);

    const payload = {
      run: toRunDto(run),
      trajectory,
      stages: stages.map((stage) =>
        StageRunDtoSchema.parse({
          id: stage.id,
          runId: stage.run_id,
          stageId: stage.stage_id,
          kind: stage.kind,
          status: stage.status,
          attempts: stage.attempts,
          output: stage.output ?? null,
          error: stage.error ?? null,
          startedAt: iso(stage.started_at),
          finishedAt: iso(stage.finished_at),
        }),
      ),
      decisions: decisions.map((decision) => ({
        ...DecisionRecordDtoSchema.parse({
          id: decision.id,
          runId: decision.run_id,
          stageRunId: decision.stage_run_id,
          workflowId: decision.workflow_id,
          moduleId: decision.module_id,
          moduleVersion: decision.module_version,
          evidence: decision.evidence ?? null,
          deterministic: decision.deterministic ?? null,
          timings: decision.timings ?? null,
          error: decision.error ?? null,
          createdAt: new Date(decision.created_at).toISOString(),
        }),
        fallback: decision.fallback ?? null,
        outcome: decision.outcome ?? null,
      })),
    };
    // 18.T3: a run can be exported as a versioned envelope for replay/backup.
    if ((request.query as { export?: string }).export === '1') {
      return {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        pinnedVersions: run.pinned_versions ?? {},
        ...payload,
      };
    }
    return payload;
  });

  app.get('/api/v1/system/runs/:id/graph', async (request) => {
    const { id } = request.params as { id: string };
    const rows = await kernel.database.query<{ workflow_id: string; workflow_version: string }>(
      `SELECT workflow_id, workflow_version FROM workflow_runs WHERE id = $1`,
      [id],
    );
    const run = rows[0];
    if (!run) throw notFound(`run ${id} not found`);
    const graph = kernel.workflowEngine.graphFor(run.workflow_id, run.workflow_version);
    if (!graph) throw notFound(`graph for ${run.workflow_id}@${run.workflow_version} not found`);
    const stages = await kernel.database.query<{ stage_id: string; status: string }>(
      `SELECT stage_id, status FROM stage_runs WHERE run_id = $1 ORDER BY created_at, stage_id`,
      [id],
    );
    const order = stages.map((stage) => stage.stage_id);
    const takenEdges = graph.edges
      .filter((edge) =>
        order.some((stageId, index) => edge.from === stageId && edge.to === order[index + 1]),
      )
      .map((edge) => `${edge.from}->${edge.to}`);
    return {
      runId: id,
      workflowId: run.workflow_id,
      version: run.workflow_version,
      graph,
      takenEdges,
    };
  });

  app.post('/api/v1/system/runs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const cancelled = await kernel.workflowEngine.cancel(id);
    return { runId: id, cancelled };
  });

  // 19.T6: a user can flag a run whose output was wrong. Flags are audited
  // (append-only) and feed the flag rate + the scenario case pipeline. 18.T30:
  // the same call can attach user feedback / eval scores to the run's trace.
  app.post('/api/v1/system/runs/:id/flag', async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({
        reason: z.string().trim().max(2000).optional(),
        traceId: z.string().trim().max(200).optional(),
        feedback: z
          .object({
            verdict: z.enum(['helpful', 'wrong', 'unsafe']),
            note: z.string().trim().max(2000).optional(),
          })
          .strict()
          .optional(),
        evalScores: z
          .array(
            z
              .object({
                evaluator: z.string().trim().min(1).max(200),
                score: z.number().min(0).max(1),
              })
              .strict(),
          )
          .max(20)
          .optional(),
      })
      .strict()
      .parse(request.body ?? {});
    const rows = await kernel.database.query(`SELECT 1 FROM workflow_runs WHERE id = $1`, [id]);
    if (rows.length === 0) throw notFound(`run ${id} not found`, { runId: id });
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'run.flagged',
      subject: id,
      payload: {
        reason: body.reason ?? null,
        ...(body.traceId ? { traceId: body.traceId } : {}),
        ...(body.feedback ? { feedback: body.feedback.verdict } : {}),
        ...(body.evalScores ? { evalScores: body.evalScores.length } : {}),
      },
    });
    if (body.feedback || body.evalScores) {
      // Attach asynchronously to the named trace, else the run's latest trace.
      await kernel.database.query(
        `UPDATE model_call_traces
            SET trace = jsonb_set(
                  jsonb_set(trace, '{userFeedback}', $2::jsonb, true),
                  '{evalScores}',
                  COALESCE($3::jsonb, trace->'evalScores'),
                  true
                )
          WHERE trace_id = COALESCE(
            $4::text,
            (SELECT trace_id FROM model_call_traces WHERE run_id = $1 ORDER BY at DESC LIMIT 1)
          )`,
        [id, body.feedback ?? null, body.evalScores ?? null, body.traceId ?? null],
      );
    }
    return { runId: id, flagged: true };
  });
}
