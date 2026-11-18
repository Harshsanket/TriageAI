/**
 * Declarative workflow engine (Phase 2): linear stages with `when` guards,
 * per-stage retry/backoff, timeouts (AbortSignal), cancellation, fallback
 * policies, and append-only decision records.
 * Spec: docs/contracts/workflow-contract.md.
 *
 * Phase 18.3 adds the workflow graph v2 executor: a def may declare an
 * explicit `graph` (nodes + labelled edges) which the engine walks, recording
 * every transition in decision records. v1 stage lists keep running unchanged.
 */
import { ulid } from 'ulid';
import { z } from 'zod';

import { ApprovalStore } from './approvals.js';
import type { ApprovalExpiry } from './approvals.js';
import { loadApprovalPolicy } from './approvals/policy.js';
import { CircuitBreaker } from './circuitBreaker.js';
import type { CircuitBreakerOptions } from './circuitBreaker.js';
import { AppError, toStructuredError } from './errors.js';
import type { StructuredError } from './errors.js';
import { evaluateWhen, resolveRef, resolveStageInput, validateWhen } from './grammar.js';
import type { EvalContext } from './grammar.js';
import type { EventBus } from './eventbus.js';
import { graphCallsModels, rungForGraph, validateExecutionStyle } from './evals/ladder.js';
import { compileV1, validateGraph } from './graph/v2.js';
import type { GraphEdge, GraphNode, WorkflowGraph } from './graph/v2.js';
import { callModel } from './models/callModel.js';
import type { ModelTask } from './models/callModel.js';
import { validateRoutine } from './operations/autonomy.js';
import { invokeWithApproval } from './tools/pipeline.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type {
  ChatModel,
  Database,
  JobProgressUpdate,
  JobStatus,
  KernelLogger,
  QueueCapability,
  StageHandlerContext,
  StageHandlerDef,
  WorkflowDef,
} from './types.js';

/**
 * Engine-level deps the graph executor needs that are not KernelContext
 * capabilities themselves (18.T20). They are injected at boot like the other
 * constructor deps; absence degrades gracefully (nodes record a failure and
 * follow the default edge instead of crashing the run).
 */
export interface WorkflowEngineDeps {
  /** Resolves the configured ChatModel lazily (for `llm_decision` nodes). */
  chatModel?: () => ChatModel | undefined;
  /** Resolves the kernel ToolRegistry lazily (for `tool` nodes). */
  toolRegistry?: () => ToolRegistry | undefined;
}

interface RegisteredWorkflow {
  def: WorkflowDef;
  moduleId: string;
  moduleVersion: string;
}

/** Terminal + non-reprocessable run states (idempotent re-delivery guard). */
const FINAL_RUN_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING']);

const KNOWN_FALLBACK_POLICIES = new Set([
  'halt_run',
  'return_uncertain',
  'request_clarification',
  'escalate_human',
  'retry_alternative_retrieval',
]);

const DEFAULT_BACKOFF_MS = [100, 500, 1000];

export class RunCancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'RunCancelledError';
  }
}

export class StageTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`stage timed out after ${timeoutMs}ms`);
    this.name = 'StageTimeoutError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const UNAVAILABLE_QUEUE: QueueCapability = {
  start() {
    throw new Error('queue is not available in this context');
  },
  async startWorkflow() {
    throw new Error('queue is not available in this context');
  },
  registerWorker() {
    throw new Error('queue is not available in this context');
  },
  async drain() {},
};

/** Map a policy id to the terminal action the engine takes after a failure. */
function fallbackAction(policy: string): 'fail' | 'awaiting' {
  return policy === 'halt_run' || policy === 'retry_alternative_retrieval' ? 'fail' : 'awaiting';
}

/** Shared walk state for one graph run. */
interface GraphState {
  runId: string;
  workflow: RegisteredWorkflow;
  graph: WorkflowGraph;
  nodesById: Map<string, GraphNode>;
  /** Declared control-flow edges (no `on` categories, no compensate flag). */
  outgoing: Map<string, GraphEdge[]>;
  /** Error edges keyed by their source node. */
  errorEdges: Map<string, GraphEdge[]>;
  /** Compensation edges keyed by the node they unwind. */
  compensateEdges: Map<string, GraphEdge[]>;
  data: Record<string, Record<string, unknown> | undefined>;
  config: Record<string, unknown>;
  orgId: string | null;
  ownerId: string | null;
  input: unknown;
  maxSteps: number;
  steps: number;
  loopIterations: Map<string, number>;
  /** Executed nodes that declared compensation, in execution order. */
  compensations: Array<{ nodeId: string; targets: string[]; handlerKinds: string[] }>;
  /** Branch promises a parallel node left for its join. */
  joinPending: Map<string, Array<Promise<GraphChainResult>>>;
  /** The structured failure that routed the run onto an error edge. */
  lastError?: StructuredError;
  /** Tool node whose approval was just granted; execute it with approved:true. */
  approvedNode?: string;
}

type GraphChainResult =
  | { stopNodeId: string; stopType: 'join' | 'end' }
  | { failed: StructuredError }
  | { cancelled: true };

type GraphNodeOutcome =
  | {
      kind: 'next';
      to: string;
      label: string;
      guards?: Record<string, unknown>;
      hopEvidence?: Record<string, unknown>;
      stageRunId: string;
    }
  | { kind: 'failed'; structured: StructuredError; stageRunId: string }
  | { kind: 'cancelled'; stageRunId?: string }
  | { kind: 'awaitingApproval'; approvalId: string; stageRunId: string }
  | {
      kind: 'end';
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'escalated';
      stageRunId: string;
    };

/**
 * Run thunks with a bounded concurrency; returns one promise per thunk in
 * declaration order (parallelism caps for `parallel`/`map` nodes).
 */
function runLimited<T>(thunks: Array<() => Promise<T>>, limit: number): Array<Promise<T>> {
  let active = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (active < Math.max(1, limit)) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  };
  const release = (): void => {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };
  return thunks.map((thunk) =>
    (async () => {
      await acquire();
      try {
        return await thunk();
      } finally {
        release();
      }
    })(),
  );
}

export class WorkflowEngine {
  private workflows = new Map<string, RegisteredWorkflow>();
  private graphs = new Map<string, WorkflowGraph>();
  private handlers = new Map<string, StageHandlerDef>();
  private running = new Map<string, AbortController>();
  private cancelled = new Set<string>();

  private breaker: CircuitBreaker;
  private deps: WorkflowEngineDeps;

  constructor(
    private database: Database,
    private logger: KernelLogger,
    private events?: EventBus,
    private queueCapability?: QueueCapability,
    breakerOptions: CircuitBreakerOptions = {},
    deps: WorkflowEngineDeps = {},
  ) {
    this.breaker = new CircuitBreaker(breakerOptions);
    this.deps = deps;
  }

  /**
   * Register a workflow definition. v1 stage lists compile to a straight-line
   * graph and validate lazily at start(); explicit v2 graphs validate HERE so
   * a broken graph fails boot (ADR-0007 restart-time gating).
   */
  register(def: WorkflowDef, moduleId: string, moduleVersion: string): void {
    if (def.graph) {
      const problems = this.validateGraphDef(def);
      if (problems.length > 0) {
        throw new AppError(
          'kernel.WORKFLOW_INVALID',
          `workflow ${def.id}: invalid graph (${problems.length} problem${problems.length === 1 ? '' : 's'})`,
          problems,
          undefined,
          {
            category: 'validation',
            retryable: false,
            userMessage: 'The workflow definition is invalid; check the boot logs.',
          },
        );
      }
      this.graphs.set(`${def.id}@${def.version}`, def.graph);
    } else {
      this.graphs.set(
        `${def.id}@${def.version}`,
        compileV1({
          id: def.id,
          version: def.version,
          module: def.module,
          trigger: def.trigger,
          stages: def.stages.map((stage) => ({
            id: stage.id,
            kind: stage.kind,
            ...(stage.when ? { when: stage.when } : {}),
          })),
        }),
      );
    }
    this.workflows.set(def.id, { def, moduleId, moduleVersion });
  }

  /**
   * Load-time validation for an explicit v2 graph (18.T19/T23/T33-partial):
   * graph shape, execution-style ladder and routine rules. Returns the
   * collected problem list so registration can reject with one error.
   */
  private validateGraphDef(def: WorkflowDef): string[] {
    const graph = def.graph;
    if (!graph) return [];
    const problems = validateGraph(graph);
    problems.push(
      ...validateExecutionStyle({
        rung: rungForGraph(graph),
        executionStyleReason: graph.executionStyleReason,
        hasUnboundedLoop: graph.nodes.some(
          (node) => node.type === 'loop' && !node.loop?.maxIterations,
        ),
      }),
    );
    const trigger = graph.trigger ?? def.trigger;
    if (trigger.type === 'schedule') {
      const scheduleConfig = (trigger.config ?? {}) as Record<string, unknown>;
      problems.push(
        ...validateRoutine({
          cron:
            graph.trigger.schedule?.cron ??
            (typeof scheduleConfig.cron === 'string' ? scheduleConfig.cron : ''),
          probe: graph.trigger.schedule?.probe,
          overlap: graph.trigger.schedule?.overlap,
          modelCalling: graphCallsModels(graph),
          intervalMinutes:
            typeof scheduleConfig.intervalMinutes === 'number'
              ? scheduleConfig.intervalMinutes
              : undefined,
          when: trigger.when,
        }),
      );
    }
    return problems;
  }

  graphFor(id: string, version?: string): WorkflowGraph | undefined {
    if (version) return this.graphs.get(`${id}@${version}`);
    return [...this.graphs.entries()]
      .filter(([key]) => key.startsWith(`${id}@`))
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
      .at(-1)?.[1];
  }

  get(id: string): RegisteredWorkflow | undefined {
    return this.workflows.get(id);
  }

  list(): RegisteredWorkflow[] {
    return [...this.workflows.values()];
  }

  registerStageHandler(kind: string, def: StageHandlerDef): void {
    if (this.handlers.has(kind)) {
      this.logger.warn({ kind }, 'stage handler kind re-registered; last registration wins');
    }
    this.handlers.set(kind, def);
  }

  /**
   * Create a run + enqueue its execution. Idempotency: a workflow-level
   * idempotency key returns the existing run instead of a new one.
   */
  async start(
    workflowId: string,
    input: unknown,
    opts: {
      idempotencyKey?: string;
      orgId?: string | null;
      trigger?: string;
      pinnedVersions?: Record<string, unknown>;
      ownerId?: string | null;
      title?: string;
      total?: number;
      unit?: string;
    } = {},
  ): Promise<{ runId: string; deduped: boolean }> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`workflow ${workflowId} is not registered`);
    }
    this.validateDef(workflow.def);

    const key = opts.idempotencyKey ?? null;
    if (key) {
      const existing = await this.database.query<{ id: string }>(
        `SELECT id FROM workflow_runs WHERE workflow_id = $1 AND idempotency_key = $2`,
        [workflowId, key],
      );
      if (existing[0]) return { runId: existing[0].id, deduped: true };
    }

    const runId = ulid();
    await this.database.query(
      `INSERT INTO workflow_runs
         (id, workflow_id, workflow_version, trigger, status, idempotency_key, input, pinned_versions, owner_id, org_id)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7, $8, $9)`,
      [
        runId,
        workflowId,
        workflow.def.version,
        opts.trigger ?? 'endpoint',
        key,
        input ?? null,
        opts.pinnedVersions ?? {},
        opts.ownerId ?? null,
        opts.orgId ?? null,
      ],
    );
    if (opts.title) {
      await this.database.query(
        `INSERT INTO job_progress
           (job_id, run_id, workflow_id, owner_id, title, done, total, unit, status)
         VALUES ($1, $1, $2, $3, $4, 0, $5, $6, 'running')
         ON CONFLICT (job_id) DO UPDATE
           SET title = EXCLUDED.title, total = EXCLUDED.total, unit = EXCLUDED.unit,
               owner_id = EXCLUDED.owner_id, updated_at = now()`,
        [
          runId,
          workflowId,
          opts.ownerId ?? null,
          opts.title,
          Math.max(0, opts.total ?? 0),
          opts.unit ?? 'items',
        ],
      );
    }
    return { runId, deduped: false };
  }

  /**
   * Write durable progress for a run and publish the generic `run.progress`
   * event. Callers report monotonic `done` counts; the engine clamps them.
   */
  async reportProgress(runId: string, update: JobProgressUpdate): Promise<void> {
    const run = await this.database.query<{
      workflow_id: string;
      owner_id: string | null;
    }>(`SELECT workflow_id, owner_id FROM workflow_runs WHERE id = $1`, [runId]);
    const row = run[0];
    const status: JobStatus = update.status ?? 'running';
    const done = Math.max(0, Math.trunc(update.done ?? 0));
    const total = Math.max(0, Math.trunc(update.total ?? 0));
    await this.database.query(
      `INSERT INTO job_progress
         (job_id, run_id, workflow_id, owner_id, title, stage, done, total, unit, status, error, detail)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (job_id) DO UPDATE SET
         stage = COALESCE(EXCLUDED.stage, job_progress.stage),
         done = GREATEST(job_progress.done, EXCLUDED.done),
         total = CASE WHEN EXCLUDED.total > 0 THEN EXCLUDED.total ELSE job_progress.total END,
         unit = EXCLUDED.unit,
         status = EXCLUDED.status,
         error = COALESCE(EXCLUDED.error, job_progress.error),
         detail = job_progress.detail || EXCLUDED.detail,
         title = CASE WHEN $12::text IS NULL THEN job_progress.title ELSE $12 END,
         updated_at = now()`,
      [
        runId,
        row?.workflow_id ?? null,
        row?.owner_id ?? null,
        update.title ?? row?.workflow_id ?? 'workflow',
        update.stage ?? null,
        done,
        total,
        update.unit ?? 'items',
        status,
        update.error ?? null,
        update.detail ?? {},
        update.title ?? null,
      ],
    );
    if (this.events) {
      await this.events.publish('run.progress', {
        runId,
        done,
        total,
        unit: update.unit ?? 'items',
        stage: update.stage ?? null,
        status,
      });
    }
  }

  /**
   * Request cancellation. The current attempt is aborted (AbortSignal) and the
   * run terminates as CANCELLED at the next boundary; handlers must be
   * kill-safe (idempotent/transactional side effects).
   */
  async cancel(runId: string): Promise<boolean> {
    const rows = await this.database.query<{ status: string }>(
      `UPDATE workflow_runs SET status = 'CANCELLED_PENDING'
       WHERE id = $1 AND status IN ('PENDING','RUNNING')
       RETURNING status`,
      [runId],
    );
    if (rows.length === 0) return false;
    this.cancelled.add(runId);
    this.running.get(runId)?.abort(new RunCancelledError());
    return true;
  }

  // ── graph approvals (Phase 18.3) ───────────────────────────────────────────

  /**
   * Resume a run parked on an `approval` node along the matching edge
   * (approved/rejected/expired). Idempotent: a run that is no longer AWAITING,
   * an unknown/mismatched approval, or a concurrently decided one are no-ops.
   */
  async resolveApproval(
    runId: string,
    approvalId: string,
    outcome: 'approved' | 'rejected' | 'expired',
    opts: { approver?: string; reason?: string; editedInput?: unknown } = {},
  ): Promise<{ resumed: boolean }> {
    const runRows = await this.database.query<{
      id: string;
      workflow_id: string;
      status: string;
      input: unknown;
      org_id: string | null;
      owner_id: string | null;
    }>(`SELECT id, workflow_id, status, input, org_id, owner_id FROM workflow_runs WHERE id = $1`, [
      runId,
    ]);
    const run = runRows[0];
    if (!run) return { resumed: false };
    const approvalRows = await this.database.query<{
      id: string;
      run_id: string;
      step_id: string;
      status: string;
    }>(`SELECT id, run_id, step_id, status FROM approvals WHERE id = $1`, [approvalId]);
    const approval = approvalRows[0];
    if (!approval || approval.run_id !== runId) return { resumed: false };
    const workflow = this.workflows.get(run.workflow_id);
    if (!workflow?.def.graph) return { resumed: false };
    if (approval.status !== 'pending' && approval.status !== outcome) return { resumed: false };
    if (approval.status === 'pending') {
      try {
        if (outcome === 'expired') {
          await this.database.query(
            `UPDATE approvals SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'pending'`,
            [approvalId],
          );
        } else {
          await new ApprovalStore(this.database).decide(
            approvalId,
            outcome === 'approved',
            opts.approver ?? 'kernel.workflow',
            opts.reason,
          );
        }
      } catch {
        return { resumed: false }; // lost a concurrent decision
      }
    }
    return this.resumeApprovalRun(run, workflow, approval.step_id, outcome, approvalId, {
      editedInput: opts.editedInput,
    });
  }

  /** Latest approval for a run; returns it only when it expired (auto-resume). */
  private async findExpiredApproval(
    runId: string,
  ): Promise<{ approvalId: string; stepId: string } | null> {
    const rows = await this.database.query<{ id: string; step_id: string; status: string }>(
      `SELECT id, step_id, status FROM approvals WHERE run_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [runId],
    );
    const latest = rows[0];
    if (!latest || latest.status !== 'expired') return null;
    return { approvalId: latest.id, stepId: latest.step_id };
  }

  /** Flip the parked run back to RUNNING and continue the graph at `nodeId`. */
  private async resumeApprovalRun(
    run: { id: string; input: unknown; org_id: string | null; owner_id: string | null },
    workflow: RegisteredWorkflow,
    nodeId: string,
    outcome: 'approved' | 'rejected' | 'expired',
    approvalId: string,
    opts: { editedInput?: unknown },
  ): Promise<{ resumed: boolean }> {
    const graph = workflow.def.graph;
    if (!graph) return { resumed: false };
    const updated = await this.database.query<{ id: string }>(
      `UPDATE workflow_runs SET status = 'RUNNING' WHERE id = $1 AND status = 'AWAITING' RETURNING id`,
      [run.id],
    );
    if (updated.length === 0) return { resumed: false };
    const data: Record<string, Record<string, unknown> | undefined> = {
      input:
        run.input == null
          ? {}
          : typeof run.input === 'object'
            ? (run.input as Record<string, unknown>)
            : (JSON.parse(String(run.input)) as Record<string, unknown>),
    };
    const stageRows = await this.database.query<{ stage_id: string; output: unknown }>(
      `SELECT stage_id, output FROM stage_runs WHERE run_id = $1 AND status = 'SUCCEEDED' ORDER BY created_at`,
      [run.id],
    );
    for (const row of stageRows) data[row.stage_id] = (row.output as Record<string, unknown>) ?? {};
    if (opts.editedInput !== undefined) {
      data[nodeId] = { ...(data[nodeId] ?? {}), editedInput: opts.editedInput };
    }
    const state = this.buildGraphState(run, workflow, graph, data);
    const nodeRows = await this.database.query<{ id: string }>(
      `SELECT id FROM stage_runs WHERE run_id = $1 AND stage_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [run.id, nodeId],
    );
    const stageRunId = nodeRows[0]?.id ?? '';
    const parkedNode = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (parkedNode?.type === 'tool') {
      // A tool node parked itself through the high-risk pipeline. Approval
      // re-executes it with approved:true; rejection/expiry routes through the
      // node's declared error edges.
      if (outcome === 'approved') {
        await this.executeGraph(run, workflow, graph, {
          startNode: nodeId,
          data,
          approvedNode: nodeId,
        });
        return { resumed: true };
      }
      const structured: StructuredError = {
        code: 'tool.APPROVAL_REJECTED',
        category: 'policy_blocked',
        retryable: false,
        message: `tool approval ${outcome} for ${nodeId}`,
        attempt: 1,
      };
      const resolved = await this.resolveNodeFailure(parkedNode, structured, state, stageRunId);
      if (resolved === 'fail-run') {
        await this.finishRun(
          run.id,
          'FAILED',
          structured.message,
          undefined,
          run.input,
          workflow.def.id,
        );
        return { resumed: true };
      }
      await this.executeGraph(run, workflow, graph, { startNode: resolved.to, data });
      return { resumed: true };
    }
    const edge = graph.edges.find(
      (candidate) =>
        candidate.from === nodeId && !candidate.on?.length && candidate.label === outcome,
    );
    if (!edge) {
      const structured: StructuredError = {
        code: 'VALIDATION_ERROR',
        category: 'validation',
        retryable: false,
        message: `approval node ${nodeId} has no "${outcome}" edge`,
        attempt: 1,
      };
      const resolved = await this.resolveNodeFailure(
        { id: nodeId, type: 'approval' },
        structured,
        state,
        stageRunId,
      );
      if (resolved === 'fail-run') {
        await this.finishRun(
          run.id,
          'FAILED',
          structured.message,
          undefined,
          run.input,
          workflow.def.id,
        );
        this.logger.error({ runId: run.id, node: nodeId }, 'approval resume failed');
        return { resumed: true };
      }
      await this.executeGraph(run, workflow, graph, { startNode: resolved.to, data });
      return { resumed: true };
    }
    await this.writeHop({
      state,
      from: { id: nodeId, type: 'approval' },
      to: edge.to,
      label: outcome,
      extra: {
        approvalId,
        ...(opts.editedInput !== undefined ? { editedInput: opts.editedInput } : {}),
      },
      stageRunId,
    });
    await this.executeGraph(run, workflow, graph, { startNode: edge.to, data });
    return { resumed: true };
  }

  private validateDef(def: WorkflowDef): void {
    if (def.graph) return; // validated at register() (boot); nothing stage-based to check
    if (def.stages.length === 0) {
      throw new Error(`workflow ${def.id} has no stages`);
    }
    const graphProblems = validateGraph(
      compileV1({
        id: def.id,
        version: def.version,
        module: def.module,
        stages: def.stages.map((stage) => ({
          id: stage.id,
          kind: stage.kind,
          ...(stage.when ? { when: stage.when } : {}),
        })),
      }),
    );
    if (graphProblems.length > 0) {
      throw new AppError(
        'kernel.WORKFLOW_INVALID',
        `workflow ${def.id}: invalid when or graph: ${graphProblems.join('; ')}`,
      );
    }
    if (def.fallbackPolicyId && !KNOWN_FALLBACK_POLICIES.has(def.fallbackPolicyId)) {
      throw new Error(
        `workflow ${def.id}: unknown fallbackPolicyId "${def.fallbackPolicyId}" (known: ${[...KNOWN_FALLBACK_POLICIES].join(', ')})`,
      );
    }
    const seen = new Set<string>();
    for (const stage of def.stages) {
      if (seen.has(stage.id)) throw new Error(`workflow ${def.id}: duplicate stage id ${stage.id}`);
      seen.add(stage.id);
      if (stage.when !== undefined) {
        try {
          validateWhen(stage.when);
        } catch (err) {
          throw new Error(
            `workflow ${def.id} stage ${stage.id}: invalid when: ${(err as Error).message}`,
          );
        }
      }
      if (stage.retry && (!Number.isInteger(stage.retry.attempts) || stage.retry.attempts < 1)) {
        throw new Error(`workflow ${def.id} stage ${stage.id}: retry.attempts must be >= 1`);
      }
      if (stage.timeoutMs !== undefined && stage.timeoutMs <= 0) {
        throw new Error(`workflow ${def.id} stage ${stage.id}: timeoutMs must be > 0`);
      }
      if (stage.onError === 'fallback' && !def.fallbackPolicyId) {
        throw new Error(
          `workflow ${def.id} stage ${stage.id}: onError "fallback" requires fallbackPolicyId`,
        );
      }
    }
    for (const stage of def.stages) {
      if (!this.handlers.has(stage.kind)) {
        throw new Error(
          `workflow ${def.id} stage ${stage.id}: no handler for kind "${stage.kind}" (registered by modules?)`,
        );
      }
    }
  }

  /** Executes a run sequentially. Queue-level retry repeats it; guard on done states. */
  async processRun(runId: string): Promise<void> {
    const rows = await this.database.query<{
      id: string;
      workflow_id: string;
      status: string;
      input: unknown;
      trigger: string;
      org_id: string | null;
      owner_id: string | null;
      finished_at: string | null;
    }>(
      `SELECT id, workflow_id, status, input, trigger, org_id, owner_id, finished_at FROM workflow_runs WHERE id = $1`,
      [runId],
    );
    const run = rows[0];
    if (!run) {
      this.logger.warn({ runId }, 'run row missing; dropping job');
      return;
    }
    if (FINAL_RUN_STATES.has(run.status)) {
      // Graph runs parked on an approval whose expiry already passed resume
      // along the `expired` edge on the next delivery; every other terminal
      // state stays an idempotent no-op (v1 behaviour unchanged).
      if (run.status === 'AWAITING' && run.finished_at == null) {
        const parked = this.workflows.get(run.workflow_id);
        if (parked?.def.graph) {
          const expired = await this.findExpiredApproval(runId);
          if (expired) {
            await this.resumeApprovalRun(
              run,
              parked,
              expired.stepId,
              'expired',
              expired.approvalId,
              {},
            );
            return;
          }
        }
      }
      return; // idempotent re-delivery
    }

    if (run.status === 'CANCELLED_PENDING') {
      await this.finishRun(runId, 'CANCELLED', null, undefined, run.input, run.workflow_id);
      return;
    }

    const workflow = this.workflows.get(run.workflow_id);
    if (!workflow) {
      await this.finishRun(
        runId,
        'FAILED',
        'workflow not registered',
        undefined,
        run.input,
        run.workflow_id,
      );
      return;
    }

    await this.database.query(
      `UPDATE workflow_runs SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1`,
      [runId],
    );

    // Explicit graph (Phase 18.3): walk declared nodes/edges; v1 keeps the
    // linear stage loop below untouched.
    if (workflow.def.graph) {
      await this.executeGraph(run, workflow, workflow.def.graph);
      return;
    }

    const data: Record<string, Record<string, unknown> | undefined> = {
      input:
        run.input == null
          ? {}
          : typeof run.input === 'object'
            ? (run.input as Record<string, unknown>)
            : (JSON.parse(String(run.input)) as Record<string, unknown>),
    };
    const evalCtx: EvalContext = { data, config: workflow.def.config ?? {}, runId };

    for (let index = 0; index < workflow.def.stages.length; index++) {
      const stage = workflow.def.stages[index] as WorkflowDef['stages'][number];

      if (await this.isCancelled(runId)) {
        await this.cascadeCancel(runId, workflow.def.stages.slice(index));
        await this.finishRun(runId, 'CANCELLED', null, undefined, run.input, run.workflow_id);
        return;
      }

      // `when` skips are recorded, never silently dropped (§3).
      if (stage.when !== undefined && !evaluateWhen(stage.when, evalCtx)) {
        const stageRunId = ulid();
        const now = new Date().toISOString();
        await this.database.query(
          `INSERT INTO stage_runs (id, run_id, stage_id, kind, status, attempts, input, output, error, started_at, finished_at)
           VALUES ($1, $2, $3, $4, 'SKIPPED', 0, NULL, NULL, NULL, $5, $5)`,
          [stageRunId, runId, stage.id, stage.kind, now],
        );
        await this.writeDecision({
          runId,
          stageRunId,
          workflow,
          stage,
          evidence: { skipped: true, when: stage.when },
          deterministic: null,
          timings: { attempted: 0, durationMs: 0 },
          outcome: { skipped: true },
        });
        data[stage.id] = {};
        continue;
      }

      const resolvedInput =
        stage.input !== undefined
          ? resolveStageInput(stage.input, evalCtx)
          : { ...(data.input ?? {}) };

      const outcome = await this.executeStage({
        runId,
        workflow,
        stage,
        resolvedInput,
        data,
      });
      if (outcome.kind === 'cancelled') {
        await this.cascadeCancel(runId, workflow.def.stages.slice(index + 1));
        await this.finishRun(runId, 'CANCELLED', null, undefined, run.input, run.workflow_id);
        return;
      }
      if (outcome.kind === 'awaiting') {
        await this.finishRun(
          runId,
          'AWAITING',
          outcome.error ?? null,
          undefined,
          run.input,
          run.workflow_id,
        );
        this.logger.warn(
          { runId, policy: workflow.def.fallbackPolicyId },
          'run awaiting fallback outcome',
        );
        return;
      }
      if (outcome.kind === 'failed') {
        await this.finishRun(runId, 'FAILED', outcome.error, undefined, run.input, run.workflow_id);
        this.logger.error({ runId, err: outcome.error }, 'run failed');
        return;
      }
      data[stage.id] = outcome.output;
    }

    const outputs: Record<string, Record<string, unknown> | undefined> = {};
    for (const stage of workflow.def.stages) outputs[stage.id] = data[stage.id];
    await this.finishRun(runId, 'SUCCEEDED', null, outputs, run.input, run.workflow_id);
    this.logger.info({ runId, workflow: workflow.def.id }, 'run succeeded');
  }

  // ── graph execution (Phase 18.3, workflow graph v2) ────────────────────────

  private async executeGraph(
    run: { id: string; input: unknown; org_id: string | null; owner_id: string | null },
    workflow: RegisteredWorkflow,
    graph: WorkflowGraph,
    resume?: {
      startNode: string;
      data: Record<string, Record<string, unknown> | undefined>;
      approvedNode?: string;
    },
  ): Promise<void> {
    const state = this.buildGraphState(run, workflow, graph, resume?.data, resume?.approvedNode);
    let current = resume?.startNode ?? graph.start;
    for (;;) {
      if (state.steps >= state.maxSteps) {
        await this.failGraphRun(state, current, {
          code: 'BUDGET_EXCEEDED',
          category: 'budget_exceeded',
          retryable: false,
          message: `graph budget of ${state.maxSteps} steps exhausted at node ${current}`,
          attempt: state.steps,
        });
        return;
      }
      if (await this.isCancelled(state.runId)) {
        await this.finishRun(
          state.runId,
          'CANCELLED',
          null,
          undefined,
          state.input,
          workflow.def.id,
        );
        return;
      }
      const node = state.nodesById.get(current);
      if (!node) {
        await this.failGraphRun(state, current, {
          code: 'INTERNAL_ERROR',
          category: 'internal',
          retryable: false,
          message: `graph references missing node ${current}`,
          attempt: state.steps,
        });
        return;
      }
      const outcome = await this.executeNode(node, state, false);
      if (outcome.kind === 'next') {
        state.steps += 1;
        await this.writeHop({
          state,
          from: node,
          to: outcome.to,
          label: outcome.label,
          guards: outcome.guards,
          extra: outcome.hopEvidence,
          stageRunId: outcome.stageRunId,
        });
        current = outcome.to;
        continue;
      }
      if (outcome.kind === 'failed') {
        state.steps += 1;
        const resolved = await this.resolveNodeFailure(
          node,
          outcome.structured,
          state,
          outcome.stageRunId,
        );
        if (resolved === 'fail-run') {
          await this.finishRun(
            state.runId,
            'FAILED',
            outcome.structured.message,
            undefined,
            state.input,
            workflow.def.id,
          );
          this.logger.error(
            { runId: state.runId, node: node.id, err: outcome.structured.message },
            'graph run failed',
          );
          return;
        }
        current = resolved.to;
        continue;
      }
      if (outcome.kind === 'cancelled') {
        await this.finishRun(
          state.runId,
          'CANCELLED',
          null,
          undefined,
          state.input,
          workflow.def.id,
        );
        return;
      }
      if (outcome.kind === 'awaitingApproval') {
        // Park without finishing: the run stays resumable via resolveApproval.
        await this.database.query(
          `UPDATE workflow_runs SET status = 'AWAITING' WHERE id = $1 AND status IN ('PENDING','RUNNING')`,
          [state.runId],
        );
        this.logger.warn(
          { runId: state.runId, node: node.id, approvalId: outcome.approvalId },
          'run awaiting approval',
        );
        return;
      }
      await this.finishGraphRun(state, outcome.outcome);
      return;
    }
  }

  private buildGraphState(
    run: { id: string; input: unknown; org_id: string | null; owner_id: string | null },
    workflow: RegisteredWorkflow,
    graph: WorkflowGraph,
    data?: Record<string, Record<string, unknown> | undefined>,
    approvedNode?: string,
  ): GraphState {
    const nodesById = new Map<string, GraphNode>();
    for (const node of graph.nodes) nodesById.set(node.id, node);
    const outgoing = new Map<string, GraphEdge[]>();
    const errorEdges = new Map<string, GraphEdge[]>();
    const compensateEdges = new Map<string, GraphEdge[]>();
    for (const edge of graph.edges) {
      if (edge.on && edge.on.length > 0) {
        errorEdges.set(edge.from, [...(errorEdges.get(edge.from) ?? []), edge]);
        continue;
      }
      if (edge.compensate) {
        compensateEdges.set(edge.from, [...(compensateEdges.get(edge.from) ?? []), edge]);
        continue;
      }
      outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    }
    const inputData =
      run.input == null
        ? {}
        : typeof run.input === 'object'
          ? (run.input as Record<string, unknown>)
          : (JSON.parse(String(run.input)) as Record<string, unknown>);
    const base: Record<string, Record<string, unknown> | undefined> = data ?? { input: inputData };
    return {
      runId: run.id,
      workflow,
      graph,
      nodesById,
      outgoing,
      errorEdges,
      compensateEdges,
      data: base,
      config: workflow.def.config ?? {},
      orgId: run.org_id,
      ownerId: run.owner_id,
      input: run.input,
      maxSteps: graph.budget?.maxSteps ?? graph.nodes.length * 10,
      steps: 0,
      loopIterations: new Map<string, number>(),
      compensations: [],
      joinPending: new Map<string, Array<Promise<GraphChainResult>>>(),
      ...(approvedNode ? { approvedNode } : {}),
    };
  }

  private evalCtx(state: GraphState): EvalContext {
    return { data: state.data, config: state.config, runId: state.runId };
  }

  private evaluate(when: string, state: GraphState): boolean {
    try {
      return evaluateWhen(when, this.evalCtx(state));
    } catch {
      return false; // guards are validated at load; unparseable guards never pass
    }
  }

  private normalEdges(state: GraphState, nodeId: string): GraphEdge[] {
    return state.outgoing.get(nodeId) ?? [];
  }

  /** Next control-flow edge: an exact label match first, then the first eligible by `when`. */
  private nextEdge(
    state: GraphState,
    node: GraphNode,
    opts: { preferLabel?: string } = {},
  ): GraphEdge | null {
    const edges = this.normalEdges(state, node.id);
    if (opts.preferLabel !== undefined) {
      const exact = edges.find((edge) => edge.label === opts.preferLabel);
      if (exact) return exact;
    }
    return edges.find((edge) => !edge.when || this.evaluate(edge.when, state)) ?? null;
  }

  private defaultEdgeOf(state: GraphState, nodeId: string): GraphEdge | null {
    const edges = this.normalEdges(state, nodeId);
    return edges.find((edge) => edge.isDefault || edge.label === 'default') ?? null;
  }

  /** One node, dispatched by type. `compensating` runs mark rows, not new compensation entries. */
  private async executeNode(
    node: GraphNode,
    state: GraphState,
    compensating: boolean,
  ): Promise<GraphNodeOutcome> {
    switch (node.type) {
      case 'stage':
        return this.executeStageNode(node, state, compensating);
      case 'branch':
        return this.executeBranchNode(node, state);
      case 'llm_decision':
        return this.executeLlmDecisionNode(node, state);
      case 'agent_step':
        return this.executeAgentStepNode(node, state, compensating);
      case 'tool':
        return this.executeToolNode(node, state);
      case 'approval':
        return this.executeApprovalNode(node, state);
      case 'parallel':
        return this.executeParallelNode(node, state);
      case 'join':
        return this.executeJoinNode(node, state);
      case 'map':
        return this.executeMapNode(node, state);
      case 'loop':
        return this.executeLoopNode(node, state);
      case 'subworkflow':
        return this.executeSubworkflowNode(node, state);
      case 'wait':
        return this.executeWaitNode(node, state);
      case 'end':
        return this.executeEndNode(node, state);
    }
  }

  private structuredFailure(
    code: string,
    category: StructuredError['category'],
    message: string,
    retryable = false,
  ): StructuredError {
    return { code, category, retryable, message, attempt: 1 };
  }

  private async graphRowOutcome(
    node: GraphNode,
    state: GraphState,
    structured: StructuredError,
  ): Promise<GraphNodeOutcome> {
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'FAILED',
      input: {},
      error: structured.message,
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: { node: node.id, type: node.type, failed: true, reason: structured.message },
      deterministic: null,
      timings: {},
      error: structured,
      outcome: { status: 'FAILED' },
    });
    return { kind: 'failed', structured, stageRunId };
  }

  /** `stage` nodes reuse the v1 stage machinery end to end (rows, retries, breaker). */
  private async executeStageNode(
    node: GraphNode,
    state: GraphState,
    compensating: boolean,
  ): Promise<GraphNodeOutcome> {
    if (!node.kind) {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `stage node ${node.id} declares no handler kind`,
        ),
      );
    }
    const stage: WorkflowDef['stages'][number] = {
      id: node.id,
      kind: node.kind,
      ...(node.input ? { input: node.input as Record<string, unknown> } : {}),
      ...(node.config ? { config: node.config } : {}),
      ...(node.retry ? { retry: node.retry } : {}),
      ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
    };
    const resolvedInput =
      stage.input !== undefined
        ? resolveStageInput(stage.input, this.evalCtx(state))
        : { ...(state.data.input ?? {}) };
    const outcome = await this.executeStage({
      runId: state.runId,
      workflow: state.workflow,
      stage,
      resolvedInput,
      data: state.data,
    });
    if (outcome.kind === 'succeeded') {
      state.data[node.id] = outcome.output;
      if (!compensating) this.registerCompensation(node, state);
      const edge = this.nextEdge(state, node);
      if (!edge) {
        return this.graphRowOutcome(
          node,
          state,
          this.structuredFailure(
            'VALIDATION_ERROR',
            'validation',
            `stage node ${node.id} has no eligible outgoing edge`,
          ),
        );
      }
      return { kind: 'next', to: edge.to, label: edge.label, stageRunId: outcome.stageRunId };
    }
    if (outcome.kind === 'failed') {
      return { kind: 'failed', structured: outcome.structured, stageRunId: outcome.stageRunId };
    }
    if (outcome.kind === 'cancelled') {
      return { kind: 'cancelled', stageRunId: outcome.stageRunId };
    }
    // awaiting is only reachable with a fallback policy, which graph stage nodes do not declare
    return this.graphRowOutcome(
      node,
      state,
      this.structuredFailure(
        'INTERNAL_ERROR',
        'internal',
        `stage ${node.id} returned awaiting without a fallback policy`,
      ),
    );
  }

  /** Deterministic choice: first passing `when` guard, else the default edge. */
  private async executeBranchNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const edges = this.normalEdges(state, node.id);
    const guards: Record<string, boolean> = {};
    let chosen: GraphEdge | undefined;
    let defaultEdge: GraphEdge | undefined;
    for (const edge of edges) {
      if (edge.isDefault || edge.label === 'default') {
        defaultEdge = defaultEdge ?? edge;
        continue;
      }
      if (edge.when === undefined) {
        chosen = chosen ?? edge;
        continue;
      }
      const passes = this.evaluate(edge.when, state);
      guards[edge.label] = passes;
      if (passes) chosen = chosen ?? edge;
    }
    chosen = chosen ?? defaultEdge;
    if (!chosen) {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `branch ${node.id} has no eligible outgoing edge`,
        ),
      );
    }
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'SUCCEEDED',
      input: {},
      output: { to: chosen.to, label: chosen.label },
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: { branch: node.id, chosen: { to: chosen.to, label: chosen.label }, guards },
      deterministic: { branch: node.id, choice: chosen.label },
      timings: {},
      outcome: { status: 'SUCCEEDED', to: chosen.to, label: chosen.label },
    });
    return {
      kind: 'next',
      to: chosen.to,
      label: chosen.label,
      guards,
      stageRunId,
    };
  }

  /**
   * Bounded model choice between the node's outgoing edge labels. Invalid or
   * undeclared output takes the default edge and is recorded — it never fails
   * the run (ADR-0011 §18.3).
   */
  private async executeLlmDecisionNode(
    node: GraphNode,
    state: GraphState,
  ): Promise<GraphNodeOutcome> {
    const startedAt = new Date();
    const edges = this.normalEdges(state, node.id);
    const labels = [...new Set(edges.map((edge) => edge.label))];
    const defaultEdge = this.defaultEdgeOf(state, node.id);
    const resolvedInput =
      node.input !== undefined
        ? resolveStageInput(node.input as Record<string, unknown>, this.evalCtx(state))
        : { ...(state.data.input ?? {}) };
    const takeDefault = async (
      reason: string,
      modelOutput: Record<string, unknown> | null,
    ): Promise<GraphNodeOutcome> => {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'SUCCEEDED',
        input: resolvedInput,
        output: { usedDefault: true, reason },
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { llm_decision: node.id, usedDefault: true, reason },
        deterministic: null,
        timings: { durationMs: Date.now() - startedAt.getTime() },
        modelOutput,
        outcome: { status: 'SUCCEEDED', usedDefault: true, reason },
      });
      if (!defaultEdge) {
        return this.graphRowOutcome(
          node,
          state,
          this.structuredFailure(
            'VALIDATION_ERROR',
            'validation',
            `llm_decision ${node.id} has no default edge for an invalid model choice`,
          ),
        );
      }
      return {
        kind: 'next',
        to: defaultEdge.to,
        label: defaultEdge.label,
        hopEvidence: { usedDefault: true, llmFailure: reason },
        stageRunId,
      };
    };
    const model = this.deps.chatModel?.();
    if (!model) {
      this.logger.warn({ runId: state.runId, node: node.id }, 'no chat model for llm_decision');
      return takeDefault('no chat model configured for llm_decision', null);
    }
    if (labels.length === 0) {
      return takeDefault('llm_decision node declares no choice labels', null);
    }
    const task: ModelTask = {
      id: 'llm_decision',
      promptTemplateId: 'graph.llm_decision',
      promptVersion: '1',
      outputSchema: z.object({
        choice: z.enum(labels as [string, ...string[]]),
        reason: z.string(),
      }),
      maxOutputTokens: 64,
      timeoutMs: 30_000,
      requiredFields: ['choice', 'reason'],
    };
    try {
      const result = await callModel(
        { chatModel: model, logger: this.logger },
        task,
        {
          runId: state.runId,
          workflowId: state.workflow.def.id,
          workflowVersion: state.workflow.def.version,
          stepName: node.id,
        },
        {
          messages: [
            {
              role: 'system',
              content:
                'You route one declared workflow step. Reply with JSON only: {"choice": <one of the allowed choices>, "reason": <short justification>}.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                step: node.id,
                input: resolvedInput,
                allowedChoices: labels,
              }),
            },
          ],
          structured: true,
        },
      );
      const parsed = result.parsed as { choice?: unknown; reason?: unknown } | undefined;
      const choice = typeof parsed?.choice === 'string' ? parsed.choice : undefined;
      const reason = typeof parsed?.reason === 'string' ? parsed.reason : '';
      const modelOutput: Record<string, unknown> = {
        choice: choice ?? null,
        reason,
        provider: result.trace.provider,
        model: result.trace.modelName,
        usage: { inputTokens: result.trace.tokensIn, outputTokens: result.trace.tokensOut },
        fallbackUsed: result.fallbackUsed,
      };
      if (!choice || !labels.includes(choice)) {
        return takeDefault(
          `model choice ${String(parsed?.choice)} is not a declared label`,
          modelOutput,
        );
      }
      const edge = edges.find((candidate) => candidate.label === choice) ?? defaultEdge;
      if (!edge) {
        return takeDefault('no outgoing edge for the declared choice', modelOutput);
      }
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'SUCCEEDED',
        input: resolvedInput,
        output: { choice, reason },
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { llm_decision: node.id, choice, reason },
        deterministic: { choice, labels },
        timings: { durationMs: result.trace.latencyMs },
        modelOutput,
        outcome: { status: 'SUCCEEDED', choice },
      });
      return { kind: 'next', to: edge.to, label: edge.label, hopEvidence: { choice }, stageRunId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { runId: state.runId, node: node.id, err: message },
        'llm_decision failed; taking the default edge',
      );
      return takeDefault(message, { error: message });
    }
  }

  /**
   * One bounded agent iteration via the stage-handler registry: the handler
   * returns `{ decision: <label>, ... }`; undeclared decisions take the node's
   * default edge and are recorded.
   */
  private async executeAgentStepNode(
    node: GraphNode,
    state: GraphState,
    compensating: boolean,
  ): Promise<GraphNodeOutcome> {
    const kind = node.kind ?? node.id;
    const stage: WorkflowDef['stages'][number] = {
      id: node.id,
      kind,
      ...(node.input ? { input: node.input as Record<string, unknown> } : {}),
      ...(node.config ? { config: node.config } : {}),
      ...(node.retry ? { retry: node.retry } : {}),
      ...(node.timeoutMs !== undefined ? { timeoutMs: node.timeoutMs } : {}),
    };
    const resolvedInput =
      stage.input !== undefined
        ? resolveStageInput(stage.input, this.evalCtx(state))
        : { ...(state.data.input ?? {}) };
    const outcome = await this.executeStage({
      runId: state.runId,
      workflow: state.workflow,
      stage,
      resolvedInput,
      data: state.data,
    });
    if (outcome.kind === 'cancelled') return { kind: 'cancelled', stageRunId: outcome.stageRunId };
    if (outcome.kind === 'failed') {
      return { kind: 'failed', structured: outcome.structured, stageRunId: outcome.stageRunId };
    }
    if (outcome.kind === 'awaiting') {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'INTERNAL_ERROR',
          'internal',
          `agent_step ${node.id} returned awaiting without a fallback policy`,
        ),
      );
    }
    const output = outcome.output;
    state.data[node.id] = output;
    if (!compensating) this.registerCompensation(node, state);
    const decision = typeof output?.decision === 'string' ? output.decision : undefined;
    const edges = this.normalEdges(state, node.id);
    const matched =
      decision !== undefined ? edges.find((edge) => edge.label === decision) : undefined;
    if (matched) {
      return {
        kind: 'next',
        to: matched.to,
        label: matched.label,
        hopEvidence: { decision },
        stageRunId: outcome.stageRunId,
      };
    }
    const defaultEdge = this.defaultEdgeOf(state, node.id);
    if (defaultEdge) {
      await this.writeDecision({
        runId: state.runId,
        stageRunId: outcome.stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind },
        evidence: {
          agent_step: node.id,
          invalidDecision: decision ?? null,
          usedDefault: true,
        },
        deterministic: { agent_step: node.id, usedDefault: true },
        timings: {},
        outcome: { status: 'SUCCEEDED', usedDefault: true },
      });
      return {
        kind: 'next',
        to: defaultEdge.to,
        label: defaultEdge.label,
        hopEvidence: { invalidDecision: decision ?? null, usedDefault: true },
        stageRunId: outcome.stageRunId,
      };
    }
    return {
      kind: 'failed',
      structured: this.structuredFailure(
        'VALIDATION_ERROR',
        'validation',
        `agent_step ${node.id} produced decision ${String(decision)} with no default edge`,
      ),
      stageRunId: outcome.stageRunId,
    };
  }

  /** Calls one tool through the kernel ToolRegistry under the tool contract. */
  private async executeToolNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const startedAt = new Date();
    const toolName = node.tool;
    const registry = this.deps.toolRegistry?.();
    const resolvedInput =
      node.input !== undefined
        ? resolveStageInput(node.input as Record<string, unknown>, this.evalCtx(state))
        : { ...(state.data.input ?? {}) };
    const fail = async (structured: StructuredError): Promise<GraphNodeOutcome> => {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'FAILED',
        input: resolvedInput,
        error: structured.message,
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { tool: toolName ?? null, failed: true },
        deterministic: null,
        timings: { durationMs: Date.now() - startedAt.getTime() },
        error: structured,
        outcome: { status: 'FAILED' },
      });
      return { kind: 'failed', structured, stageRunId };
    };
    if (!toolName) {
      return fail(
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `tool node ${node.id} declares no tool`,
        ),
      );
    }
    const tool = registry?.get(toolName);
    if (!tool) {
      return fail(
        this.structuredFailure('tool.NOT_FOUND', 'not_found', `tool ${toolName} is not registered`),
      );
    }
    const context: ToolContext = {
      runId: state.runId,
      stepId: node.id,
      ...(state.ownerId ? { actorId: state.ownerId } : {}),
      grantedScopes: [...tool.scopes],
      egressClass: tool.egressClass,
      org: { ownsEmail: () => false },
      logger: this.logger,
    };
    // 15.T2/T8: writes go through preview → policy → approval (or auto), then
    // verification and a deterministic receipt. A parked write returns
    // `awaitingApproval` so the run stays resumable via resolveApproval.
    const approvalCount = await this.database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM approvals WHERE run_id = $1 AND tool_name = $2`,
      [state.runId, toolName],
    );
    const expiryValue = node.config?.approvalExpiresAfterMs;
    const expiresAfterMs = typeof expiryValue === 'number' ? expiryValue : undefined;
    const onExpiryValue = node.config?.onExpiry;
    const onExpiry: ApprovalExpiry | undefined =
      onExpiryValue === 'escalate' ||
      onExpiryValue === 'cancel' ||
      onExpiryValue === 'park_as_draft'
        ? onExpiryValue
        : undefined;
    let result: Awaited<ReturnType<ToolRegistry['invoke']>>;
    if (state.approvedNode === node.id) {
      // A human approved this tool's pending request: execute it now, then
      // continue along the node's normal edge.
      result = await registry!.invoke(toolName, resolvedInput, context, {
        approved: true,
        idempotencyKey: `${state.runId}:${node.id}`,
      });
    } else {
      const outcome = await invokeWithApproval(registry!, {
        tool: toolName,
        input: resolvedInput,
        ctx: context,
        approvals: new ApprovalStore(this.database),
        policy: await loadApprovalPolicy(this.database),
        stepId: node.id,
        idempotencyKey: `${state.runId}:${node.id}`,
        runCount: Number(approvalCount[0]?.count ?? 0),
        ...(expiresAfterMs === undefined ? {} : { expiresAfterMs }),
        ...(onExpiry === undefined ? {} : { onExpiry }),
      });
      if (outcome.status === 'awaiting') {
        const stageRunId = await this.writeGraphNodeRow(node, state, {
          status: 'AWAITING',
          input: resolvedInput,
          output: { approvalId: outcome.approval.id },
        });
        await this.writeDecision({
          runId: state.runId,
          stageRunId,
          workflow: state.workflow,
          stage: { id: node.id, kind: node.kind ?? node.type },
          evidence: {
            tool: toolName,
            approvalId: outcome.approval.id,
            policyReason: outcome.decision.reason,
          },
          deterministic: { tool: toolName, approval: outcome.decision.action },
          timings: { durationMs: Date.now() - startedAt.getTime() },
          outcome: { status: 'AWAITING', approvalId: outcome.approval.id },
        });
        return { kind: 'awaitingApproval', approvalId: outcome.approval.id, stageRunId };
      }
      if (outcome.status === 'blocked') {
        return fail({
          code: outcome.error.code,
          category: outcome.error.category,
          retryable: outcome.error.retryable,
          message: outcome.error.message,
          attempt: 1,
        });
      }
      result = outcome.result;
    }
    if (!result.ok) {
      return fail({
        code: result.error.code,
        category: result.error.category,
        retryable: result.error.retryable,
        message: result.error.message,
        attempt: 1,
      });
    }
    const output = (result.data as Record<string, unknown>) ?? {};
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'SUCCEEDED',
      input: resolvedInput,
      output,
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: { tool: toolName, ...(result.refs ? { refs: result.refs } : {}) },
      deterministic: { tool: toolName },
      timings: { durationMs: Date.now() - startedAt.getTime() },
      outcome: { status: 'SUCCEEDED' },
    });
    state.data[node.id] = output;
    this.registerCompensation(node, state);
    const edge = this.nextEdge(state, node);
    if (!edge) {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `tool node ${node.id} has no eligible outgoing edge`,
        ),
      );
    }
    return { kind: 'next', to: edge.to, label: edge.label, stageRunId };
  }

  /** Creates an approval request and parks the run (resumable via resolveApproval). */
  private async executeApprovalNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const startedAt = new Date();
    const store = new ApprovalStore(this.database);
    const resolvedInput =
      node.input !== undefined
        ? resolveStageInput(node.input as Record<string, unknown>, this.evalCtx(state))
        : { ...(state.data.input ?? {}) };
    // Idempotent creation: a pending approval for this run+node is reused on re-delivery.
    const existing = await this.database.query<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id = $1 AND step_id = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [state.runId, node.id],
    );
    const expiry =
      typeof node.config?.onExpiry === 'string' &&
      ['escalate', 'cancel', 'park_as_draft'].includes(node.config.onExpiry)
        ? (node.config.onExpiry as 'escalate' | 'cancel' | 'park_as_draft')
        : 'park_as_draft';
    const approval = existing[0]
      ? { id: existing[0].id }
      : await store.create({
          runId: state.runId,
          stepId: node.id,
          toolName: node.tool ?? node.kind ?? 'graph.approval',
          input: resolvedInput,
          preview: node.config?.preview ?? null,
          expiresAfterMs: node.approval?.expiresAfterMs ?? 86_400_000,
          onExpiry: expiry,
        });
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'SUCCEEDED',
      input: resolvedInput,
      output: { approvalId: approval.id, awaiting: true },
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: {
        approval: approval.id,
        approvers: node.approval?.approvers ?? [],
        awaiting: true,
      },
      deterministic: { parked: true },
      timings: { durationMs: Date.now() - startedAt.getTime() },
      outcome: { status: 'AWAITING', approvalId: approval.id },
    });
    return { kind: 'awaitingApproval', approvalId: approval.id, stageRunId };
  }

  /** Starts declared branch chains concurrently (capped) and hands them to the join. */
  private async executeParallelNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const startedAt = new Date();
    const edges = this.normalEdges(state, node.id);
    const branchTarget = edges[0]?.to;
    if (!branchTarget) {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `parallel ${node.id} declares no branches`,
        ),
      );
    }
    const stop = this.staticChainStop(branchTarget, state);
    if (!stop) {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `parallel ${node.id} branches do not converge on a join or end node`,
        ),
      );
    }
    const promises = runLimited(
      edges.map((edge) => async (): Promise<GraphChainResult> => {
        try {
          return await this.runChain(edge.to, state);
        } catch (err) {
          return { failed: toStructuredError(err, 0) };
        }
      }),
      this.parallelismOf(node),
    );
    if (stop.stopType === 'end') {
      // No join: the chains stop at the terminal node; wait for them, then finish.
      for (const promise of promises) await promise;
    } else {
      state.joinPending.set(stop.stopNodeId, promises);
    }
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'SUCCEEDED',
      input: {},
      output: { branches: edges.map((edge) => edge.to) },
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: { parallel: node.id, branches: edges.map((edge) => edge.to) },
      deterministic: { maxParallel: this.parallelismOf(node) },
      timings: { durationMs: Date.now() - startedAt.getTime() },
      outcome: { status: 'SUCCEEDED', branches: edges.length },
    });
    return { kind: 'next', to: stop.stopNodeId, label: 'join', stageRunId };
  }

  /**
   * Statically predict where a chain starting at `startNodeId` stops (the first
   * join/end node following single-successor edges). Chains run dynamically via
   * runChain; this only decides where the walk resumes.
   */
  private staticChainStop(
    startNodeId: string,
    state: GraphState,
    seen = new Set<string>(),
  ): { stopNodeId: string; stopType: 'join' | 'end' } | null {
    let current = startNodeId;
    while (!seen.has(current)) {
      seen.add(current);
      const node = state.nodesById.get(current);
      if (!node) return null;
      if (node.type === 'join' || node.type === 'end') {
        return { stopNodeId: node.id, stopType: node.type };
      }
      const edges = this.normalEdges(state, current);
      const next = edges.find((edge) => !edge.when) ?? edges[0];
      if (!next) return null;
      current = next.to;
    }
    return null; // cyclic body without a join — unsupported
  }

  /**
   * Waits for the pending branch chains per the declared rule (all/any/n)
   * within `branchTimeoutMs`; timeout becomes a failure routed via error edges.
   */
  private async executeJoinNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const startedAt = new Date();
    const join = node.join ?? { mode: 'all' as const, branchTimeoutMs: 120_000 };
    const pending = state.joinPending.get(node.id) ?? [];
    state.joinPending.delete(node.id);
    const fail = async (structured: StructuredError): Promise<GraphNodeOutcome> => {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'FAILED',
        input: {},
        error: structured.message,
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { join: node.id, mode: join.mode, failed: true },
        deterministic: null,
        timings: { durationMs: Date.now() - startedAt.getTime() },
        error: structured,
        outcome: { status: 'FAILED' },
      });
      return { kind: 'failed', structured, stageRunId };
    };
    const deadline = Date.now() + Math.max(0, join.branchTimeoutMs);
    const settled: Array<
      { ok: true; value: GraphChainResult } | { ok: false; error: StructuredError } | undefined
    > = new Array(pending.length).fill(undefined);
    pending.forEach((promise, index) => {
      void promise.then(
        (value) => {
          settled[index] = { ok: true, value };
        },
        (err) => {
          settled[index] = { ok: false, error: toStructuredError(err, 0) };
        },
      );
    });
    let successes = 0;
    let firstFailure: StructuredError | null = null;
    for (;;) {
      if (await this.isCancelled(state.runId)) return { kind: 'cancelled' };
      successes = 0;
      firstFailure = null;
      for (const entry of settled) {
        if (!entry) continue;
        if (entry.ok) successes += 1;
        else firstFailure = firstFailure ?? entry.error;
      }
      if (join.mode === 'all') {
        if (firstFailure) return fail(firstFailure);
        if (successes === pending.length) break;
      } else if (join.mode === 'any') {
        if (successes > 0) break;
      } else if (successes >= (join.n ?? 1)) {
        break;
      }
      if (Date.now() >= deadline) {
        return fail(
          this.structuredFailure(
            'TIMEOUT',
            'timeout',
            `join ${node.id} timed out after ${join.branchTimeoutMs}ms`,
            true,
          ),
        );
      }
      await sleep(50);
    }
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'SUCCEEDED',
      input: {},
      output: { joined: successes, mode: join.mode },
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: { join: node.id, mode: join.mode, joined: successes, of: pending.length },
      deterministic: { join: node.id, mode: join.mode },
      timings: { durationMs: Date.now() - startedAt.getTime() },
      outcome: { status: 'SUCCEEDED', joined: successes },
    });
    state.data[node.id] = { joined: successes, mode: join.mode };
    const edge = this.nextEdge(state, node);
    if (!edge) {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `join ${node.id} has no eligible outgoing edge`,
        ),
      );
    }
    return { kind: 'next', to: edge.to, label: edge.label, stageRunId };
  }

  /** Runs the body chain per item of a declared list, capped at maxParallel (default 4). */
  private async executeMapNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const startedAt = new Date();
    const itemsRef =
      node.map?.items ?? (typeof node.config?.items === 'string' ? node.config.items : undefined);
    const fail = async (structured: StructuredError): Promise<GraphNodeOutcome> => {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'FAILED',
        input: {},
        error: structured.message,
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { map: node.id, failed: true },
        deterministic: null,
        timings: { durationMs: Date.now() - startedAt.getTime() },
        error: structured,
        outcome: { status: 'FAILED' },
      });
      return { kind: 'failed', structured, stageRunId };
    };
    if (!itemsRef) {
      return fail(
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `map ${node.id} declares no items source`,
        ),
      );
    }
    let items: unknown;
    try {
      items = resolveRef(itemsRef, this.evalCtx(state));
    } catch (err) {
      return fail(
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `map ${node.id} items: ${(err as Error).message}`,
        ),
      );
    }
    if (!Array.isArray(items)) {
      return fail(
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `map ${node.id} items ${itemsRef} did not resolve to a list`,
        ),
      );
    }
    const bodyTarget = this.normalEdges(state, node.id)[0]?.to;
    if (!bodyTarget) {
      return fail(
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `map ${node.id} declares no body edge`,
        ),
      );
    }
    const promises = runLimited(
      items.map((item) => async (): Promise<GraphChainResult> => {
        const itemState: GraphState = {
          ...state,
          data: {
            ...state.data,
            item:
              item != null && typeof item === 'object'
                ? (item as Record<string, unknown>)
                : { value: item },
            input: {
              ...(state.data.input ?? {}),
              item: item as Record<string, unknown>,
            },
          },
        };
        try {
          return await this.runChain(bodyTarget, itemState);
        } catch (err) {
          return { failed: toStructuredError(err, 0) };
        }
      }),
      this.parallelismOf(node),
    );
    const results: GraphChainResult[] = [];
    for (const promise of promises) results.push(await promise);
    const cancelled = results.find((entry) => 'cancelled' in entry);
    if (cancelled) return { kind: 'cancelled' };
    const failure = results.find((entry) => 'failed' in entry);
    if (failure && 'failed' in failure) {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'FAILED',
        input: { items: items.length },
        error: failure.failed.message,
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { map: node.id, items: items.length, failed: true },
        deterministic: null,
        timings: { durationMs: Date.now() - startedAt.getTime() },
        error: failure.failed,
        outcome: { status: 'FAILED' },
      });
      return { kind: 'failed', structured: failure.failed, stageRunId };
    }
    const stops = results.filter(
      (entry): entry is Extract<GraphChainResult, { stopNodeId: string }> => 'stopNodeId' in entry,
    );
    const endStop = stops.find((stop) => stop.stopType === 'end');
    const stopNodeId = (endStop ?? stops[0])?.stopNodeId;
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'SUCCEEDED',
      input: { items: items.length },
      output: { count: items.length, body: bodyTarget, stopNode: stopNodeId ?? null },
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: { map: node.id, items: items.length, body: bodyTarget },
      deterministic: { maxParallel: this.parallelismOf(node) },
      timings: { durationMs: Date.now() - startedAt.getTime() },
      outcome: { status: 'SUCCEEDED', count: items.length },
    });
    state.data[node.id] = { count: items.length };
    const stopNode = stopNodeId ? state.nodesById.get(stopNodeId) : undefined;
    if (stopNode?.type === 'end') return this.executeEndNode(stopNode, state);
    if (!stopNodeId) {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `map ${node.id} bodies do not converge on a join or end node`,
        ),
      );
    }
    return { kind: 'next', to: stopNodeId, label: 'join', stageRunId };
  }

  /** Repeats the body while the condition holds, hard-capped by maxIterations. */
  private async executeLoopNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const cfg = node.loop;
    const fail = async (structured: StructuredError): Promise<GraphNodeOutcome> => {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'FAILED',
        input: {},
        error: structured.message,
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { loop: node.id, failed: true },
        deterministic: null,
        timings: {},
        error: structured,
        outcome: { status: 'FAILED' },
      });
      return { kind: 'failed', structured, stageRunId };
    };
    if (!cfg) {
      return fail(
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `loop ${node.id} declares no condition`,
        ),
      );
    }
    const iterations = state.loopIterations.get(node.id) ?? 0;
    let condition: boolean;
    if (cfg.while === 'true' || cfg.while === 'false') {
      condition = cfg.while === 'true';
    } else {
      try {
        condition = evaluateWhen(cfg.while, this.evalCtx(state));
      } catch (err) {
        return fail(
          this.structuredFailure(
            'VALIDATION_ERROR',
            'validation',
            `loop ${node.id} while: ${(err as Error).message}`,
          ),
        );
      }
    }
    const edges = this.normalEdges(state, node.id);
    const backEdge = edges.find((edge) => edge.label === 'again') ?? edges[0];
    const exitEdge = edges.find((edge) => edge !== backEdge);
    if (condition && iterations < cfg.maxIterations && backEdge) {
      state.loopIterations.set(node.id, iterations + 1);
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'SUCCEEDED',
        input: {},
        output: { iteration: iterations + 1 },
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { loop: node.id, iteration: iterations + 1, condition: true },
        deterministic: { loop: node.id, maxIterations: cfg.maxIterations },
        timings: {},
        outcome: { status: 'SUCCEEDED', iteration: iterations + 1 },
      });
      return {
        kind: 'next',
        to: backEdge.to,
        label: backEdge.label,
        hopEvidence: { loopIteration: iterations + 1 },
        stageRunId,
      };
    }
    if (exitEdge) {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'SUCCEEDED',
        input: {},
        output: { iterations, exited: true },
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: {
          loop: node.id,
          iterations,
          exited: true,
          reason: condition ? 'maxIterations' : 'condition',
        },
        deterministic: { loop: node.id, exited: true },
        timings: {},
        outcome: { status: 'SUCCEEDED', exited: true, iterations },
      });
      return {
        kind: 'next',
        to: exitEdge.to,
        label: exitEdge.label,
        hopEvidence: { loopExited: true, iterations },
        stageRunId,
      };
    }
    return fail(
      this.structuredFailure('INTERNAL_ERROR', 'internal', `loop ${node.id} has no exit edge`),
    );
  }

  /** Starts the referenced workflow through the engine's own start path. */
  private async executeSubworkflowNode(
    node: GraphNode,
    state: GraphState,
  ): Promise<GraphNodeOutcome> {
    const startedAt = new Date();
    const target = node.workflow;
    const fail = async (structured: StructuredError): Promise<GraphNodeOutcome> => {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'FAILED',
        input: {},
        error: structured.message,
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { subworkflow: target?.id ?? null, failed: true },
        deterministic: null,
        timings: { durationMs: Date.now() - startedAt.getTime() },
        error: structured,
        outcome: { status: 'FAILED' },
      });
      return { kind: 'failed', structured, stageRunId };
    };
    if (!target) {
      return fail(
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `subworkflow ${node.id} declares no workflow`,
        ),
      );
    }
    const queue = this.queueCapability;
    if (!queue) {
      return fail(
        this.structuredFailure(
          'DEPENDENCY_UNAVAILABLE',
          'dependency_unavailable',
          'queue capability is unavailable for subworkflow start',
        ),
      );
    }
    const resolvedInput =
      node.input !== undefined
        ? resolveStageInput(node.input as Record<string, unknown>, this.evalCtx(state))
        : { ...(state.data.input ?? {}) };
    let started: { runId: string; deduped: boolean };
    try {
      // Dedupe/idempotency preserved: one child run per (parent run, node).
      started = await queue.startWorkflow(target.id, resolvedInput, {
        idempotencyKey: `subworkflow:${state.runId}:${node.id}`,
        trigger: 'subworkflow',
        orgId: state.orgId,
        ownerId: state.ownerId,
      });
    } catch (err) {
      return fail(toStructuredError(err, 1));
    }
    if (!target.wait) {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'SUCCEEDED',
        input: resolvedInput,
        output: { runId: started.runId, fireAndForget: true },
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { subworkflow: target.id, runId: started.runId, fireAndForget: true },
        deterministic: { wait: false },
        timings: { durationMs: Date.now() - startedAt.getTime() },
        outcome: { status: 'SUCCEEDED', runId: started.runId },
      });
      state.data[node.id] = { runId: started.runId };
      const edge = this.nextEdge(state, node);
      if (!edge) {
        return this.graphRowOutcome(
          node,
          state,
          this.structuredFailure(
            'VALIDATION_ERROR',
            'validation',
            `subworkflow ${node.id} has no eligible outgoing edge`,
          ),
        );
      }
      return { kind: 'next', to: edge.to, label: edge.label, stageRunId };
    }
    const deadline = Date.now() + (node.timeoutMs ?? 300_000);
    let childStatus: string | null = null;
    for (;;) {
      if (await this.isCancelled(state.runId)) return { kind: 'cancelled' };
      const childRows = await this.database.query<{ status: string }>(
        `SELECT status FROM workflow_runs WHERE id = $1`,
        [started.runId],
      );
      const status = childRows[0]?.status;
      if (status === undefined || FINAL_RUN_STATES.has(status)) {
        childStatus = status ?? 'MISSING';
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(50);
    }
    if (childStatus === null) {
      return fail(
        this.structuredFailure(
          'TIMEOUT',
          'timeout',
          `subworkflow ${target.id} did not finish within ${node.timeoutMs ?? 300_000}ms`,
          true,
        ),
      );
    }
    if (childStatus !== 'SUCCEEDED') {
      return fail(
        this.structuredFailure(
          'INTERNAL_ERROR',
          'internal',
          `subworkflow ${target.id} (${started.runId}) finished ${childStatus}`,
        ),
      );
    }
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'SUCCEEDED',
      input: resolvedInput,
      output: { runId: started.runId, status: childStatus },
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: { subworkflow: target.id, runId: started.runId, status: childStatus },
      deterministic: { wait: true },
      timings: { durationMs: Date.now() - startedAt.getTime() },
      outcome: { status: 'SUCCEEDED', runId: started.runId, childStatus },
    });
    state.data[node.id] = { runId: started.runId, status: childStatus };
    const edge = this.nextEdge(state, node);
    if (!edge) {
      return this.graphRowOutcome(
        node,
        state,
        this.structuredFailure(
          'VALIDATION_ERROR',
          'validation',
          `subworkflow ${node.id} has no eligible outgoing edge`,
        ),
      );
    }
    return { kind: 'next', to: edge.to, label: edge.label, stageRunId };
  }

  /** Bounded wait for an event (best-effort in-process bus) or a duration. */
  private async executeWaitNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const startedAt = new Date();
    const event = typeof node.config?.event === 'string' ? node.config.event : undefined;
    const durationMs =
      typeof node.config?.durationMs === 'number' ? node.config.durationMs : undefined;
    const fail = async (structured: StructuredError): Promise<GraphNodeOutcome> => {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'FAILED',
        input: {},
        error: structured.message,
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { wait: node.id, failed: true },
        deterministic: null,
        timings: { durationMs: Date.now() - startedAt.getTime() },
        error: structured,
        outcome: { status: 'FAILED' },
      });
      return { kind: 'failed', structured, stageRunId };
    };
    const proceed = async (evidence: Record<string, unknown>): Promise<GraphNodeOutcome> => {
      const stageRunId = await this.writeGraphNodeRow(node, state, {
        status: 'SUCCEEDED',
        input: {},
        output: evidence,
      });
      await this.writeDecision({
        runId: state.runId,
        stageRunId,
        workflow: state.workflow,
        stage: { id: node.id, kind: node.kind ?? node.type },
        evidence: { wait: node.id, ...evidence },
        deterministic: { waited: true },
        timings: { durationMs: Date.now() - startedAt.getTime() },
        outcome: { status: 'SUCCEEDED', ...evidence },
      });
      const edges = this.normalEdges(state, node.id);
      const edge = edges.find((candidate) => candidate.label !== 'timeout') ?? edges[0];
      if (!edge) {
        return this.graphRowOutcome(
          node,
          state,
          this.structuredFailure(
            'VALIDATION_ERROR',
            'validation',
            `wait ${node.id} has no resume edge`,
          ),
        );
      }
      return { kind: 'next', to: edge.to, label: edge.label, hopEvidence: evidence, stageRunId };
    };
    if (durationMs !== undefined) {
      const deadline = Date.now() + durationMs;
      while (Date.now() < deadline) {
        if (await this.isCancelled(state.runId)) return { kind: 'cancelled' };
        await sleep(Math.min(50, Math.max(0, deadline - Date.now())));
      }
      return proceed({ waitedMs: durationMs });
    }
    if (event !== undefined) {
      if (!this.events) {
        return fail(
          this.structuredFailure(
            'DEPENDENCY_UNAVAILABLE',
            'dependency_unavailable',
            'event bus is unavailable for the wait node',
          ),
        );
      }
      let fired: unknown = null;
      let firedAt = 0;
      // Best-effort in-process subscription (ADR-0003); durable waits go through queues.
      this.events.subscribe(event, (payload: unknown) => {
        if (firedAt === 0) {
          fired = payload;
          firedAt = Date.now();
        }
      });
      const deadline = Date.now() + (node.timeoutMs ?? 60_000);
      while (firedAt === 0 && Date.now() < deadline) {
        if (await this.isCancelled(state.runId)) return { kind: 'cancelled' };
        await sleep(50);
      }
      if (firedAt > 0)
        return proceed({ event, payload: (fired ?? null) as Record<string, unknown> });
      const timeoutEdge = this.normalEdges(state, node.id).find(
        (candidate) => candidate.label === 'timeout',
      );
      if (timeoutEdge) {
        const stageRunId = await this.writeGraphNodeRow(node, state, {
          status: 'SUCCEEDED',
          input: {},
          output: { event, timedOut: true },
        });
        await this.writeDecision({
          runId: state.runId,
          stageRunId,
          workflow: state.workflow,
          stage: { id: node.id, kind: node.kind ?? node.type },
          evidence: { wait: node.id, event, timedOut: true },
          deterministic: { timedOut: true },
          timings: { durationMs: Date.now() - startedAt.getTime() },
          outcome: { status: 'SUCCEEDED', timedOut: true },
        });
        return {
          kind: 'next',
          to: timeoutEdge.to,
          label: timeoutEdge.label,
          hopEvidence: { timedOut: true },
          stageRunId,
        };
      }
      return fail(
        this.structuredFailure(
          'TIMEOUT',
          'timeout',
          `wait ${node.id} timed out waiting for ${event}`,
          true,
        ),
      );
    }
    return fail(
      this.structuredFailure(
        'VALIDATION_ERROR',
        'validation',
        `wait ${node.id} declares neither an event nor a duration`,
      ),
    );
  }

  /** Terminal node: records the outcome; escalated parks the run AWAITING. */
  private async executeEndNode(node: GraphNode, state: GraphState): Promise<GraphNodeOutcome> {
    const outcome = node.end ?? 'succeeded';
    const stageRunId = await this.writeGraphNodeRow(node, state, {
      status: 'SUCCEEDED',
      input: {},
      output: { outcome },
    });
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: node.id, kind: node.kind ?? node.type },
      evidence: { end: node.id, outcome },
      deterministic: { outcome },
      timings: {},
      outcome: { status: outcome },
    });
    return { kind: 'end', outcome, stageRunId };
  }

  /** Walk a branch chain until it reaches its join or an end node. */
  private async runChain(startNodeId: string, state: GraphState): Promise<GraphChainResult> {
    let current = startNodeId;
    for (;;) {
      if (state.steps >= state.maxSteps) {
        return {
          failed: this.structuredFailure(
            'BUDGET_EXCEEDED',
            'budget_exceeded',
            `graph budget of ${state.maxSteps} steps exhausted inside a branch at ${current}`,
          ),
        };
      }
      if (await this.isCancelled(state.runId)) return { cancelled: true };
      const node = state.nodesById.get(current);
      if (!node) {
        return {
          failed: this.structuredFailure(
            'INTERNAL_ERROR',
            'internal',
            `branch references missing node ${current}`,
          ),
        };
      }
      if (node.type === 'join' || node.type === 'end') {
        return { stopNodeId: node.id, stopType: node.type };
      }
      const outcome = await this.executeNode(node, state, false);
      if (outcome.kind === 'next') {
        state.steps += 1;
        await this.writeHop({
          state,
          from: node,
          to: outcome.to,
          label: outcome.label,
          guards: outcome.guards,
          extra: outcome.hopEvidence,
          stageRunId: outcome.stageRunId,
        });
        current = outcome.to;
        continue;
      }
      if (outcome.kind === 'failed') {
        state.steps += 1;
        const resolved = await this.resolveNodeFailure(
          node,
          outcome.structured,
          state,
          outcome.stageRunId,
        );
        if (resolved !== 'fail-run') {
          current = resolved.to;
          continue;
        }
        return { failed: outcome.structured };
      }
      if (outcome.kind === 'cancelled') return { cancelled: true };
      if (outcome.kind === 'awaitingApproval') {
        return {
          failed: this.structuredFailure(
            'INTERNAL_ERROR',
            'internal',
            `approval node ${node.id} inside a parallel branch or map body is not supported this wave`,
          ),
        };
      }
      return {
        failed: this.structuredFailure(
          'INTERNAL_ERROR',
          'internal',
          `branch reached terminal node ${node.id}`,
        ),
      };
    }
  }

  /**
   * Route a node failure: compensation first, then the node's declared error
   * edge for the error category, else the graph's default error edge, else
   * the run fails exactly like v1.
   */
  private async resolveNodeFailure(
    node: Pick<GraphNode, 'id' | 'type'>,
    structured: StructuredError,
    state: GraphState,
    stageRunId: string,
  ): Promise<{ to: string } | 'fail-run'> {
    await this.runCompensations(state, node.id);
    state.lastError = structured;
    const fallback = this.graphFallback(state, node, structured);
    const errorEdge = (state.errorEdges.get(node.id) ?? []).find((edge) =>
      edge.on?.includes(structured.category),
    );
    if (errorEdge) {
      await this.writeHop({
        state,
        from: { id: node.id, type: node.type },
        to: errorEdge.to,
        label: errorEdge.label,
        extra: {
          onCategory: structured.category,
          errorCode: structured.code,
          error: structured.message,
        },
        fallback,
        stageRunId,
      });
      return { to: errorEdge.to };
    }
    const defaultTo = state.graph.defaultErrorEdge?.to;
    if (defaultTo && state.nodesById.has(defaultTo)) {
      await this.writeHop({
        state,
        from: { id: node.id, type: node.type },
        to: defaultTo,
        label: 'error',
        extra: {
          onCategory: structured.category,
          errorCode: structured.code,
          error: structured.message,
          defaultErrorEdge: true,
        },
        fallback,
        stageRunId,
      });
      return { to: defaultTo };
    }
    return 'fail-run';
  }

  /**
   * v1 fallback-policy metadata for an error hop (workflow-contract §5).
   * Graph `stage` nodes express the fallback as declared error/`end` edges, so
   * the hop records which policy the definition attached and the terminal
   * action `finishGraphRun` will take. Non-stage nodes have no v1 counterpart
   * and record no fallback.
   */
  private graphFallback(
    state: GraphState,
    node: Pick<GraphNode, 'id' | 'type'>,
    structured: StructuredError,
  ): Record<string, unknown> | null {
    const policy = state.workflow.def.fallbackPolicyId;
    if (node.type !== 'stage' || policy === undefined) return null;
    return {
      policyApplied: policy,
      action: fallbackAction(policy),
      stageId: node.id,
      error: structured.message,
      attempts: structured.attempt,
    };
  }

  private registerCompensation(node: GraphNode, state: GraphState): void {
    const targets = (state.compensateEdges.get(node.id) ?? []).map((edge) => edge.to);
    const handlerKinds =
      typeof node.config?.compensate === 'string' ? [node.config.compensate] : [];
    if (targets.length === 0 && handlerKinds.length === 0) return;
    state.compensations.push({ nodeId: node.id, targets, handlerKinds });
  }

  /** Run declared compensations (newest first) after a later node failed. */
  private async runCompensations(state: GraphState, failedNodeId: string): Promise<void> {
    while (state.compensations.length > 0) {
      const entry = state.compensations.pop();
      if (!entry) break;
      for (const targetId of [...entry.targets].reverse()) {
        const target = state.nodesById.get(targetId);
        if (
          !target ||
          target.type === 'end' ||
          target.type === 'join' ||
          target.type === 'approval'
        ) {
          continue;
        }
        try {
          const outcome = await this.executeNode(target, state, true);
          const stageRunId =
            outcome.kind === 'cancelled' ? (outcome.stageRunId ?? '') : outcome.stageRunId;
          await this.writeDecision({
            runId: state.runId,
            stageRunId,
            workflow: state.workflow,
            stage: { id: target.id, kind: `compensation:${target.type}` },
            evidence: { compensation: true, forNode: entry.nodeId, failedNode: failedNodeId },
            deterministic: { compensation: target.id },
            timings: {},
            outcome: { status: outcome.kind },
            ...(outcome.kind === 'failed' ? { error: outcome.structured } : {}),
          });
        } catch (err) {
          this.logger.warn(
            { runId: state.runId, node: targetId, err: (err as Error).message },
            'compensation node failed',
          );
        }
      }
      for (const kind of entry.handlerKinds) {
        try {
          const handler = this.handlers.get(kind);
          if (!handler) throw new Error(`no handler for compensation kind ${kind}`);
          const input = state.data[entry.nodeId] ?? {};
          await handler.execute({
            runId: state.runId,
            orgId: null,
            workflowId: state.workflow.def.id,
            stageId: entry.nodeId,
            config: {},
            input,
            data: state.data,
            database: this.database,
            queue: this.queueCapability ?? UNAVAILABLE_QUEUE,
            signal: new AbortController().signal,
            reportProgress: (update) => this.reportProgress(state.runId, update),
          });
          const stageRunId = await this.writeGraphNodeRow(
            { id: entry.nodeId, type: 'stage', kind },
            state,
            { status: 'SUCCEEDED', input },
          );
          await this.writeDecision({
            runId: state.runId,
            stageRunId,
            workflow: state.workflow,
            stage: { id: entry.nodeId, kind: `compensation:${kind}` },
            evidence: { compensation: true, forNode: entry.nodeId, handlerKind: kind },
            deterministic: null,
            timings: {},
            outcome: { status: 'SUCCEEDED' },
          });
        } catch (err) {
          this.logger.warn(
            { runId: state.runId, node: entry.nodeId, kind, err: (err as Error).message },
            'compensation handler failed',
          );
        }
      }
    }
  }

  private parallelismOf(node: GraphNode): number {
    const declared =
      node.map?.maxParallel ??
      (typeof node.config?.maxParallel === 'number' ? node.config.maxParallel : undefined);
    return Math.max(1, declared ?? 4);
  }

  private async finishGraphRun(
    state: GraphState,
    declared: 'succeeded' | 'failed' | 'cancelled' | 'escalated',
  ): Promise<void> {
    // A failure that reached an `escalated` end keeps v1 policy semantics: the
    // policy decides AWAITING vs FAILED (workflow-contract §5).
    const policy = state.workflow.def.fallbackPolicyId;
    const outcome =
      declared === 'escalated' &&
      state.lastError !== undefined &&
      policy !== undefined &&
      fallbackAction(policy) === 'fail'
        ? 'failed'
        : declared;
    if (outcome === 'succeeded') {
      const outputs: Record<string, Record<string, unknown> | undefined> = {};
      for (const [key, value] of Object.entries(state.data)) {
        if (key !== 'input') outputs[key] = value;
      }
      await this.finishRun(
        state.runId,
        'SUCCEEDED',
        null,
        outputs,
        state.input,
        state.workflow.def.id,
      );
      this.logger.info({ runId: state.runId, workflow: state.workflow.def.id }, 'run succeeded');
      return;
    }
    if (outcome === 'failed') {
      await this.finishRun(
        state.runId,
        'FAILED',
        state.lastError?.message ?? 'graph ended with outcome failed',
        undefined,
        state.input,
        state.workflow.def.id,
      );
      this.logger.error({ runId: state.runId, node: 'end' }, 'graph run failed');
      return;
    }
    if (outcome === 'cancelled') {
      await this.finishRun(
        state.runId,
        'CANCELLED',
        null,
        undefined,
        state.input,
        state.workflow.def.id,
      );
      return;
    }
    // escalated: first-class AWAITING terminal outcome, recorded on the end node.
    // The structured failure stays on the run so subscribers can escalate with
    // the original reason (v1 logged it on the AWAITING run too).
    await this.finishRun(
      state.runId,
      'AWAITING',
      state.lastError?.message ?? null,
      undefined,
      state.input,
      state.workflow.def.id,
    );
  }

  /** Persist one hop (from → to via label) as a decision record. */
  private async writeHop(args: {
    state: GraphState;
    from: Pick<GraphNode, 'id' | 'type'>;
    to: string;
    label: string;
    guards?: Record<string, unknown>;
    extra?: Record<string, unknown>;
    fallback?: Record<string, unknown> | null;
    stageRunId: string;
  }): Promise<void> {
    let stageRunId = args.stageRunId;
    if (!stageRunId) {
      stageRunId = await this.writeGraphNodeRow(
        { id: args.from.id, type: 'stage', kind: undefined },
        args.state,
        { status: 'FAILED', input: {}, error: 'node failed before its row was written' },
      );
    }
    await this.writeDecision({
      runId: args.state.runId,
      stageRunId,
      workflow: args.state.workflow,
      stage: { id: args.from.id, kind: `hop:${args.from.type}` },
      evidence: {
        from: args.from.id,
        to: args.to,
        label: args.label,
        ...(args.extra ?? {}),
      },
      deterministic: args.guards ? { guards: args.guards } : null,
      timings: {},
      fallback: args.fallback ?? null,
      outcome: { transition: true, from: args.from.id, to: args.to, label: args.label },
    });
  }

  /** Fail the run at a node the engine could not even begin to execute. */
  private async failGraphRun(
    state: GraphState,
    nodeId: string,
    structured: StructuredError,
  ): Promise<void> {
    const stageRunId = await this.writeGraphNodeRow(
      { id: nodeId, type: 'stage', kind: undefined },
      state,
      { status: 'FAILED', input: {}, error: structured.message },
    );
    await this.writeDecision({
      runId: state.runId,
      stageRunId,
      workflow: state.workflow,
      stage: { id: nodeId, kind: 'graph' },
      evidence: { node: nodeId, failed: true, reason: structured.message },
      deterministic: null,
      timings: {},
      error: structured,
      outcome: { status: 'FAILED' },
    });
    await this.finishRun(
      state.runId,
      'FAILED',
      structured.message,
      undefined,
      state.input,
      state.workflow.def.id,
    );
    this.logger.error(
      { runId: state.runId, node: nodeId, err: structured.message },
      'graph run failed',
    );
  }

  /** Stage-run row for a graph node (inspector/graph API keep working). */
  private async writeGraphNodeRow(
    node: Pick<GraphNode, 'id' | 'type' | 'kind'>,
    state: GraphState,
    args: {
      status: 'SUCCEEDED' | 'FAILED' | 'AWAITING';
      input: Record<string, unknown>;
      output?: Record<string, unknown>;
      error?: string;
      attempts?: number;
      startedAt?: Date;
    },
  ): Promise<string> {
    const stageRunId = ulid();
    const now = new Date();
    const startedAt = args.startedAt ?? now;
    await this.database.query(
      `INSERT INTO stage_runs (id, run_id, stage_id, kind, status, attempts, input, output, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        stageRunId,
        state.runId,
        node.id,
        node.kind ?? node.type,
        args.status,
        args.attempts ?? 1,
        args.input,
        args.output ?? null,
        args.error ?? null,
        startedAt.toISOString(),
        now.toISOString(),
      ],
    );
    return stageRunId;
  }

  // ── stage execution ────────────────────────────────────────────────────────

  private breakerKeyFor(stage: WorkflowDef['stages'][number]): string {
    const configured = stage.config?.breaker;
    if (typeof configured === 'string' && configured.length > 0) return configured;
    return stage.kind.split('.')[0] ?? stage.kind;
  }

  private classifyStageError(error: unknown, attempt: number): StructuredError {
    if (error instanceof StageTimeoutError) {
      return {
        code: 'TIMEOUT',
        category: 'timeout',
        retryable: true,
        message: error.message,
        attempt,
      };
    }
    return toStructuredError(error, attempt);
  }

  private countsForBreaker(category: StructuredError['category']): boolean {
    return category === 'dependency_unavailable' || category === 'timeout';
  }

  private async finishStageFailure(args: {
    runId: string;
    workflow: RegisteredWorkflow;
    stage: WorkflowDef['stages'][number];
    stageRunId: string;
    resolvedInput: Record<string, unknown>;
    startedAt: Date;
    finishedAt: Date;
    attempt: number;
    status: 'FAILED' | 'TIMED_OUT';
    structured: StructuredError;
    fallbackRequested: boolean;
    policy?: string;
  }): Promise<
    | { kind: 'failed'; error: string; structured: StructuredError; stageRunId: string }
    | { kind: 'awaiting'; error?: string; stageRunId: string }
  > {
    const message = args.structured.message;
    if (!this.countsForBreaker(args.structured.category)) {
      this.breaker.releaseProbe(this.breakerKeyFor(args.stage));
    }
    await this.writeStageFailure({
      stageRunId: args.stageRunId,
      runId: args.runId,
      stage: args.stage,
      status: args.status,
      attempts: args.attempt,
      input: args.resolvedInput,
      error: message,
      startedAt: args.startedAt,
      finishedAt: args.finishedAt,
    });
    await this.writeDecision({
      runId: args.runId,
      stageRunId: args.stageRunId,
      workflow: args.workflow,
      stage: args.stage,
      evidence: {
        stage: args.stage.id,
        failed: true,
        reason: message,
        attempt: args.attempt,
        policyRequested: args.fallbackRequested ? args.policy : null,
      },
      deterministic: null,
      timings: {
        startedAt: args.startedAt.toISOString(),
        durationMs: args.finishedAt.getTime() - args.startedAt.getTime(),
        attempts: args.attempt,
      },
      error: args.structured,
      fallback: args.fallbackRequested
        ? {
            policyApplied: args.policy,
            action: fallbackAction(args.policy as string),
            stageId: args.stage.id,
            status: args.status,
            reasons: [message],
            attempts: args.attempt,
          }
        : null,
      outcome: { status: args.status },
    });

    if (!args.fallbackRequested)
      return {
        kind: 'failed',
        error: message,
        structured: args.structured,
        stageRunId: args.stageRunId,
      };
    if (args.policy === 'halt_run' || args.policy === 'retry_alternative_retrieval') {
      return {
        kind: 'failed',
        error: `${message} (fallback: ${args.policy})`,
        structured: args.structured,
        stageRunId: args.stageRunId,
      };
    }
    return {
      kind: 'awaiting',
      error: `${message} (fallback: ${args.policy})`,
      stageRunId: args.stageRunId,
    };
  }

  private async executeStage(args: {
    runId: string;
    workflow: RegisteredWorkflow;
    stage: WorkflowDef['stages'][number];
    resolvedInput: Record<string, unknown>;
    data: Record<string, Record<string, unknown> | undefined>;
  }): Promise<
    | { kind: 'succeeded'; output: Record<string, unknown>; stageRunId: string }
    | { kind: 'failed'; error: string; structured: StructuredError; stageRunId: string }
    | { kind: 'cancelled'; stageRunId: string }
    | { kind: 'awaiting'; error?: string; stageRunId: string }
  > {
    const { runId, workflow, stage, resolvedInput, data } = args;
    const handler = this.handlers.get(stage.kind);
    if (!handler) {
      const circuit = new AppError(
        'kernel.HANDLER_MISSING',
        `no handler for stage kind ${stage.kind}`,
        undefined,
        500,
        {
          category: 'internal',
          retryable: false,
        },
      );
      return {
        kind: 'failed',
        error: circuit.message,
        structured: toStructuredError(circuit, 0),
        stageRunId: '',
      };
    }

    const totalAttempts = stage.retry?.attempts ?? 1;
    const backoff = stage.retry?.backoffMs ?? DEFAULT_BACKOFF_MS;
    const policy = workflow.def.fallbackPolicyId;
    const fallbackRequested = stage.onError === 'fallback' && policy !== undefined;
    const breakerKey = this.breakerKeyFor(stage);
    let usesAlternative = false;

    if (this.breaker.isOpen(breakerKey)) {
      const now = new Date();
      const retryAfterMs = this.breaker.retryAfterMs(breakerKey);
      const circuit = new AppError(
        'kernel.CIRCUIT_OPEN',
        `circuit open for ${breakerKey}`,
        { key: breakerKey, retryAfterMs },
        503,
        { category: 'dependency_unavailable', retryable: true, retryAfterMs },
      );
      return this.finishStageFailure({
        runId,
        workflow,
        stage,
        stageRunId: ulid(),
        resolvedInput,
        startedAt: now,
        finishedAt: now,
        attempt: 0,
        status: 'FAILED',
        structured: toStructuredError(circuit, 0),
        fallbackRequested,
        policy,
      });
    }

    for (let attempt = 1; ; attempt++) {
      if (await this.isCancelled(runId)) return { kind: 'cancelled', stageRunId: '' };

      const stageRunId = ulid();
      const startedAt = new Date();
      const controller = new AbortController();
      this.running.set(runId, controller);
      let timer: ReturnType<typeof setTimeout> | undefined;

      try {
        const context: StageHandlerContext = {
          runId,
          orgId: null,
          workflowId: workflow.def.id,
          stageId: stage.id,
          config: stage.config ?? {},
          input: resolvedInput,
          data,
          database: this.database,
          queue: this.queueCapability ?? UNAVAILABLE_QUEUE,
          signal: controller.signal,
          reportProgress: (update) => this.reportProgress(runId, update),
        };
        const configWithAlternative = usesAlternative
          ? { ...(stage.config ?? {}), _alternate: true }
          : (stage.config ?? {});

        const executed = handler.execute({ ...context, config: configWithAlternative });
        const result = await new Promise<Awaited<ReturnType<StageHandlerDef['execute']>>>(
          (resolve, reject) => {
            if (stage.timeoutMs !== undefined) {
              timer = setTimeout(
                () => controller.abort(new StageTimeoutError(stage.timeoutMs as number)),
                stage.timeoutMs,
              );
            }
            const onAbort = (): void => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', onAbort, { once: true });
            executed.then(
              (value) => {
                controller.signal.removeEventListener('abort', onAbort);
                resolve(value);
              },
              (err) => {
                controller.signal.removeEventListener('abort', onAbort);
                reject(err);
              },
            );
          },
        );

        const finishedAt = new Date();
        const output = (result.output as Record<string, unknown>) ?? {};
        const attemptsUsed = attempt;
        await this.database.query(
          `INSERT INTO stage_runs (id, run_id, stage_id, kind, status, attempts, input, output, error, started_at, finished_at)
           VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, $6, $7, NULL, $8, $9)`,
          [
            stageRunId,
            runId,
            stage.id,
            stage.kind,
            attemptsUsed,
            resolvedInput,
            output,
            startedAt.toISOString(),
            finishedAt.toISOString(),
          ],
        );
        await this.writeDecision({
          runId,
          stageRunId,
          workflow,
          stage,
          evidence: { ...(result.evidence ?? {}), input: resolvedInput },
          deterministic: result.deterministic ?? null,
          timings: {
            startedAt: startedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            attempts: attemptsUsed,
          },
          fallback: result.fallback ?? null,
          outcome: { status: 'SUCCEEDED', output },
          adapterVersions: result.adapterVersions,
        });
        this.breaker.recordSuccess(breakerKey);
        return { kind: 'succeeded', output, stageRunId };
      } catch (err) {
        if (timer) clearTimeout(timer);
        const finishedAt = new Date();

        if (
          err instanceof RunCancelledError ||
          controller.signal.reason instanceof RunCancelledError
        ) {
          this.running.delete(runId);
          this.breaker.releaseProbe(breakerKey);
          await this.writeStageFailure({
            stageRunId,
            runId,
            stage,
            status: 'CANCELLED',
            attempts: attempt,
            input: resolvedInput,
            error: 'run cancelled',
            startedAt,
            finishedAt,
          });
          return { kind: 'cancelled', stageRunId };
        }

        const structured = this.classifyStageError(err, attempt);
        const breakerFailure = this.countsForBreaker(structured.category);
        if (breakerFailure) this.breaker.recordFailure(breakerKey);
        const breakerOpen = breakerFailure && this.breaker.isOpen(breakerKey);
        const retryOn = stage.retry?.retryOn;
        const neverRetry =
          structured.category === 'budget_exceeded' || structured.category === 'policy_blocked';
        const retryAllowed = retryOn ? retryOn.includes(structured.category) : structured.retryable;

        if (!neverRetry && retryAllowed && !breakerOpen && attempt < totalAttempts) {
          const retryAfterMs = err instanceof AppError ? (err.retryAfterMs ?? 0) : 0;
          const delay = Math.max(
            backoff[Math.min(attempt - 1, backoff.length - 1)] ??
              backoff[backoff.length - 1] ??
              100,
            retryAfterMs,
          );
          this.logger.warn(
            {
              runId,
              stage: stage.id,
              attempt,
              err: structured.message,
              category: structured.category,
            },
            'stage attempt failed; retrying',
          );
          await sleep(delay);
          continue;
        }

        // Retries exhausted: consult the fallback policy when requested.
        if (fallbackRequested && policy === 'retry_alternative_retrieval' && !usesAlternative) {
          usesAlternative = true;
          this.logger.warn(
            { runId, stage: stage.id, policy },
            'fallback: retrying with alternative strategy',
          );
          continue;
        }

        const status = structured.category === 'timeout' ? 'TIMED_OUT' : 'FAILED';
        return this.finishStageFailure({
          runId,
          workflow,
          stage,
          stageRunId,
          resolvedInput,
          startedAt,
          finishedAt,
          attempt,
          status,
          structured,
          fallbackRequested,
          policy,
        });
      } finally {
        if (timer) clearTimeout(timer);
        this.running.delete(runId);
      }
    }
  }

  // ── persistence helpers ────────────────────────────────────────────────────

  private async writeStageFailure(args: {
    stageRunId: string;
    runId: string;
    stage: WorkflowDef['stages'][number];
    status: 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
    attempts: number;
    input: Record<string, unknown>;
    error: string;
    startedAt: Date;
    finishedAt: Date;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO stage_runs (id, run_id, stage_id, kind, status, attempts, input, output, error, started_at, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, $9, $10)`,
      [
        args.stageRunId,
        args.runId,
        args.stage.id,
        args.stage.kind,
        args.status,
        args.attempts,
        args.input,
        args.error,
        args.startedAt.toISOString(),
        args.finishedAt.toISOString(),
      ],
    );
  }

  private async writeDecision(args: {
    runId: string;
    stageRunId: string;
    workflow: RegisteredWorkflow;
    stage: Pick<WorkflowDef['stages'][number], 'id' | 'kind'>;
    evidence: Record<string, unknown>;
    deterministic: Record<string, unknown> | null;
    timings: Record<string, unknown>;
    outcome?: Record<string, unknown>;
    error?: StructuredError | Record<string, unknown>;
    fallback?: Record<string, unknown> | null;
    adapterVersions?: Record<string, unknown>;
    /** What a model produced (evidence of the call, never chain-of-thought). */
    modelOutput?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO decision_records
         (id, run_id, stage_run_id, workflow_id, workflow_version, module_id, module_version,
          evidence, deterministic, model_output, timings, outcome, error, fallback, adapter_versions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        ulid(),
        args.runId,
        args.stageRunId,
        args.workflow.def.id,
        args.workflow.def.version,
        args.workflow.moduleId,
        args.workflow.moduleVersion,
        args.evidence,
        args.deterministic,
        args.modelOutput ?? null,
        args.timings,
        args.outcome ?? null,
        args.error ?? null,
        args.fallback ?? null,
        { handlerKind: args.stage.kind, ...(args.adapterVersions ?? {}) },
      ],
    );
  }

  private async isCancelled(runId: string): Promise<boolean> {
    if (this.cancelled.has(runId)) return true;
    const rows = await this.database.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE id = $1`,
      [runId],
    );
    return rows[0]?.status === 'CANCELLED_PENDING' || rows[0]?.status === 'CANCELLED';
  }

  private async cascadeCancel(runId: string, stages: WorkflowDef['stages']): Promise<void> {
    const now = new Date().toISOString();
    for (const stage of stages) {
      await this.database.query(
        `INSERT INTO stage_runs (id, run_id, stage_id, kind, status, attempts, input, output, error, started_at, finished_at)
         VALUES ($1, $2, $3, $4, 'CANCELLED', 0, NULL, NULL, 'run cancelled', $5, $5)`,
        [ulid(), runId, stage.id, stage.kind, now],
      );
    }
  }

  private async finishRun(
    runId: string,
    status: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'AWAITING',
    error: string | null,
    output?: Record<string, unknown>,
    input?: unknown,
    workflowId?: string,
  ): Promise<void> {
    await this.database.query(
      `UPDATE workflow_runs
         SET status = $2, error = $3, output = COALESCE($4::jsonb, output), finished_at = now()
       WHERE id = $1`,
      [runId, status, error, output ?? null],
    );
    const jobStatus: JobStatus =
      status === 'SUCCEEDED'
        ? 'succeeded'
        : status === 'FAILED'
          ? 'failed'
          : status === 'CANCELLED'
            ? 'cancelled'
            : 'awaiting';
    // A handler may have marked the job `partial`; never overwrite a terminal
    // status it reported with the run-level summary.
    await this.database.query(
      `UPDATE job_progress SET status = $2, error = COALESCE($3, error), updated_at = now()
       WHERE job_id = $1 AND status = 'running'`,
      [runId, jobStatus, error],
    );
    this.cancelled.delete(runId);
    this.running.delete(runId);
    // Best-effort in-process signal; subscribers must be idempotent (queue
    // re-delivery can repeat this for a given run).
    if (this.events) {
      await this.events.publish('workflow.run.finished', {
        runId,
        workflowId: workflowId ?? null,
        status,
        error,
        input: input ?? null,
      });
    }
  }
}
