/**
 * Trace-level trajectory evaluation (Phase 18.T24).
 *
 * Deterministic step scores and whole-path metrics are computed from the run's
 * own `stage_runs` and `decision_records`; no new instrumentation. Metrics are
 * persisted idempotently (one row per run) and computed on demand the first
 * time a finished run is read. Golden reference paths are optional; without one
 * path efficiency compares the taken path with its deduplicated self.
 */
import { createHash } from 'node:crypto';

import type {
  DashboardTrajectory,
  TrajectoryMetricsDto,
  TrajectoryStepScore,
} from '@triageai/contracts';
import { TrajectoryMetricsSchema } from '@triageai/contracts';
import type { Database, Kernel, TrajectoryStep } from '@triageai/kernel';
import { stepPassed, trajectoryMetrics } from '@triageai/kernel';

interface StageRow {
  [key: string]: unknown;
  id: string;
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
  stage_run_id: string;
  evidence: Record<string, unknown> | null;
  deterministic: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  fallback: Record<string, unknown> | null;
  outcome: Record<string, unknown> | null;
}

interface TrajectoryRow {
  [key: string]: unknown;
  run_id: string;
  step_count: number;
  redundant_steps: number;
  wasted_steps: number;
  path_efficiency: number | null;
  first_failing_node: string | null;
  scores: TrajectoryStepScore[] | null;
  created_at: Date | string;
}

const FINISHED_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'error';
}

function readFlag(decisions: DecisionRow[], key: 'used'): boolean | undefined {
  for (const decision of decisions) {
    for (const bag of [decision.outcome, decision.evidence, decision.deterministic]) {
      if (bag && typeof bag[key] === 'boolean') return bag[key] as boolean;
    }
  }
  return undefined;
}

function stepKind(kind: string): TrajectoryStep['kind'] {
  if (kind === 'tool' || kind.startsWith('tool.')) return 'tool';
  if (kind.includes('decision') || kind === 'branch') return 'llm_decision';
  if (kind.startsWith('agent')) return 'agent_step';
  if (kind.includes('retriev') || kind.includes('search')) return 'retrieval';
  if (kind.includes('approval')) return 'approval';
  return 'stage';
}

function toolName(kind: string, decisions: DecisionRow[]): string | undefined {
  for (const decision of decisions) {
    for (const bag of [decision.evidence, decision.deterministic]) {
      if (!bag) continue;
      const name = bag.tool ?? bag.toolName;
      if (typeof name === 'string' && name.length > 0) return name;
    }
  }
  return stepKind(kind) === 'tool' ? kind : undefined;
}

function argsHash(decisions: DecisionRow[]): string | undefined {
  for (const decision of decisions) {
    for (const bag of [decision.evidence, decision.deterministic]) {
      if (!bag) continue;
      const explicit = bag.argsHash ?? bag.args_hash;
      if (typeof explicit === 'string' && explicit.length > 0) return explicit;
      const args = bag.toolArgs ?? bag.args;
      if (args !== undefined) {
        return createHash('sha256').update(JSON.stringify(args)).digest('hex');
      }
    }
  }
  return undefined;
}

function decisionsByStage(decisions: DecisionRow[]): Map<string, DecisionRow[]> {
  const byStage = new Map<string, DecisionRow[]>();
  for (const decision of decisions) {
    byStage.set(decision.stage_run_id, [...(byStage.get(decision.stage_run_id) ?? []), decision]);
  }
  return byStage;
}

/** Deterministic step evaluator: errors, fallbacks, retries and repeats. */
export function scoreTrajectorySteps(
  stages: Array<{
    id: string;
    stage_id: string;
    kind: string;
    status: string;
    attempts: number;
    error: string | null;
  }>,
  decisions: Map<string, DecisionRow[]>,
): TrajectoryStepScore[] {
  const seen = new Set<string>();
  const scores: TrajectoryStepScore[] = [];
  for (const stage of stages) {
    if (stage.status === 'SKIPPED') continue;
    const stageDecisions = decisions.get(stage.id) ?? [];
    const findings: string[] = [];
    let score = 1;

    const failure =
      stage.error ?? stageDecisions.map((decision) => errorText(decision.error)).find(Boolean);
    if (failure) {
      score = 0;
      findings.push('stage_error');
    } else if (stage.status === 'FAILED' || stage.status === 'TIMED_OUT') {
      score = 0;
      findings.push(`stage_${stage.status.toLowerCase()}`);
    } else {
      if (stageDecisions.some((decision) => decision.fallback)) {
        score = Math.min(score, 0.6);
        findings.push('fallback_taken');
      }
      if (stage.attempts > 1) {
        score = Math.min(score, 0.8);
        findings.push(`retries:${stage.attempts}`);
      }
      const key = `${stage.kind}:${stage.stage_id}`;
      if (seen.has(key)) {
        score = Math.min(score, 0.5);
        findings.push('redundant_step');
      }
      seen.add(key);
    }

    const rounded = Number(score.toFixed(3));
    scores.push({
      nodeId: stage.stage_id,
      score: rounded,
      passed: stepPassed(rounded),
      evaluator: 'deterministic.trajectory',
      findings,
    });
  }
  return scores;
}

export interface ComputeTrajectoryOptions {
  /** Golden reference path; omit when no golden trajectory exists. */
  reference?: TrajectoryStep[];
}

/** Compute metrics + step scores from persisted run evidence. */
export async function computeTrajectory(
  database: Database,
  runId: string,
  options: ComputeTrajectoryOptions = {},
): Promise<TrajectoryMetricsDto> {
  const [stages, decisions] = await Promise.all([
    database.query<StageRow>(
      `SELECT id, stage_id, kind, status, attempts, output, error, started_at, finished_at
         FROM stage_runs WHERE run_id = $1 ORDER BY created_at, stage_id`,
      [runId],
    ),
    database.query<DecisionRow>(
      `SELECT stage_run_id, evidence, deterministic, error, fallback, outcome
         FROM decision_records WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    ),
  ]);

  const byStage = decisionsByStage(decisions);
  const takenStages = stages.filter((stage) => stage.status !== 'SKIPPED');
  const steps: TrajectoryStep[] = takenStages.map((stage) => {
    const stageDecisions = byStage.get(stage.id) ?? [];
    const used = readFlag(stageDecisions, 'used');
    const failure = stage.error ?? stageDecisions.map((d) => errorText(d.error)).find(Boolean);
    return {
      nodeId: stage.stage_id,
      kind: stepKind(stage.kind),
      ...(toolName(stage.kind, stageDecisions)
        ? { tool: toolName(stage.kind, stageDecisions) as string }
        : {}),
      ...(argsHash(stageDecisions) ? { argsHash: argsHash(stageDecisions) as string } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(failure ? { error: failure } : {}),
    };
  });

  const metrics = trajectoryMetrics(
    steps,
    steps.length > 0 ? (options.reference ?? dedupedPath(steps)) : undefined,
  );
  return {
    runId,
    steps: metrics.steps,
    redundantSteps: metrics.redundantSteps,
    wastedSteps: metrics.wastedSteps,
    pathEfficiency: metrics.pathEfficiency ?? null,
    firstFailingNode: metrics.firstFailingNode ?? null,
    scores: scoreTrajectorySteps(takenStages, byStage),
    createdAt: new Date().toISOString(),
  };
}

/**
 * No golden path: measure the taken path against its deduplicated self. A
 * redundant call therefore lowers path efficiency below 1 instead of hiding
 * the waste behind a null.
 */
function dedupedPath(steps: TrajectoryStep[]): TrajectoryStep[] {
  const seen = new Set<string>();
  const reference: TrajectoryStep[] = [];
  for (const step of steps) {
    const key = `${step.kind}:${step.nodeId}:${step.tool ?? ''}:${step.argsHash ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reference.push(step);
  }
  return reference;
}

/** Idempotent write: one trajectory row per run. */
export async function persistTrajectory(
  database: Database,
  metrics: TrajectoryMetricsDto,
): Promise<void> {
  await database.query(
    `INSERT INTO trajectory_metrics
       (run_id, step_count, redundant_steps, wasted_steps, path_efficiency,
        first_failing_node, scores, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (run_id) DO UPDATE SET
       step_count = EXCLUDED.step_count,
       redundant_steps = EXCLUDED.redundant_steps,
       wasted_steps = EXCLUDED.wasted_steps,
       path_efficiency = EXCLUDED.path_efficiency,
       first_failing_node = EXCLUDED.first_failing_node,
       scores = EXCLUDED.scores`,
    [
      metrics.runId,
      metrics.steps,
      metrics.redundantSteps,
      metrics.wastedSteps,
      metrics.pathEfficiency,
      metrics.firstFailingNode,
      metrics.scores,
      metrics.createdAt,
    ],
  );
}

export async function readTrajectory(
  database: Database,
  runId: string,
): Promise<TrajectoryMetricsDto | null> {
  const rows = await database.query<TrajectoryRow>(
    `SELECT run_id, step_count, redundant_steps, wasted_steps, path_efficiency,
            first_failing_node, scores, created_at
       FROM trajectory_metrics WHERE run_id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row) return null;
  return TrajectoryMetricsSchema.parse({
    runId: row.run_id,
    steps: Number(row.step_count),
    redundantSteps: Number(row.redundant_steps),
    wastedSteps: Number(row.wasted_steps),
    pathEfficiency: row.path_efficiency == null ? null : Number(row.path_efficiency),
    firstFailingNode: row.first_failing_node,
    scores: row.scores ?? [],
    createdAt: iso(row.created_at),
  });
}

/**
 * Read a finished run's trajectory, computing and persisting it on first read.
 * This is the documented on-demand path that replaces a second host timer.
 */
export async function ensureTrajectory(
  kernel: Kernel,
  runId: string,
): Promise<TrajectoryMetricsDto | null> {
  const existing = await readTrajectory(kernel.database, runId);
  if (existing) return existing;
  const rows = await kernel.database.query<{
    status: string;
    finished_at: Date | string | null;
  }>(`SELECT status, finished_at FROM workflow_runs WHERE id = $1`, [runId]);
  const run = rows[0];
  if (!run || !run.finished_at || !FINISHED_STATUSES.has(run.status)) return null;
  const computed = await computeTrajectory(kernel.database, runId);
  await persistTrajectory(kernel.database, computed);
  return computed;
}

/** Dashboard "Trajectory quality" tile over persisted metrics. */
export async function readTrajectoryQuality(
  database: Database,
  options: { days?: number } = {},
): Promise<DashboardTrajectory> {
  const days = options.days ?? 7;
  const rows = await database.query<{
    path_efficiency: number | null;
    wasted_steps: number;
    redundant_steps: number;
    first_failing_node: string | null;
    scores: TrajectoryStepScore[] | null;
  }>(
    `SELECT path_efficiency, wasted_steps, redundant_steps, first_failing_node, scores
       FROM trajectory_metrics
      WHERE created_at > now() - ($1 || ' days')::interval`,
    [days],
  );

  const efficiencies = rows
    .map((row) => row.path_efficiency)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  let steps = 0;
  let passed = 0;
  const failing = new Map<string, number>();
  for (const row of rows) {
    const rowScores = row.scores ?? [];
    for (const score of rowScores) {
      steps += 1;
      if (score.passed) passed += 1;
      else failing.set(score.nodeId, (failing.get(score.nodeId) ?? 0) + 1);
    }
    if (rowScores.length === 0 && row.first_failing_node) {
      failing.set(row.first_failing_node, (failing.get(row.first_failing_node) ?? 0) + 1);
    }
  }
  const mostCommonFailingStep =
    [...failing.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  return {
    runs: rows.length,
    averagePathEfficiency:
      efficiencies.length === 0
        ? null
        : Number(
            (efficiencies.reduce((sum, value) => sum + value, 0) / efficiencies.length).toFixed(3),
          ),
    stepPassRate: steps === 0 ? null : Number((passed / steps).toFixed(3)),
    wastedSteps: rows.reduce((sum, row) => sum + Number(row.wasted_steps ?? 0), 0),
    redundantSteps: rows.reduce((sum, row) => sum + Number(row.redundant_steps ?? 0), 0),
    mostCommonFailingStep,
  };
}
