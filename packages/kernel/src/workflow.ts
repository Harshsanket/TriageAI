/**
 * Declarative workflow engine (Phase 2): linear stages with `when` guards,
 * per-stage retry/backoff, timeouts (AbortSignal), cancellation, fallback
 * policies, and append-only decision records.
 * Spec: docs/contracts/workflow-contract.md.
 */
import { ulid } from 'ulid';

import { evaluateWhen, resolveStageInput, validateWhen } from './grammar.js';
import type { EvalContext } from './grammar.js';
import type { EventBus } from './eventbus.js';
import type {
  Database,
  KernelLogger,
  QueueCapability,
  StageHandlerContext,
  StageHandlerDef,
  WorkflowDef,
} from './types.js';

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

export class WorkflowEngine {
  private workflows = new Map<string, RegisteredWorkflow>();
  private handlers = new Map<string, StageHandlerDef>();
  private running = new Map<string, AbortController>();
  private cancelled = new Set<string>();

  constructor(
    private database: Database,
    private logger: KernelLogger,
    private events?: EventBus,
    private queueCapability?: QueueCapability,
  ) {}

  register(def: WorkflowDef, moduleId: string, moduleVersion: string): void {
    this.workflows.set(def.id, { def, moduleId, moduleVersion });
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
    opts: { idempotencyKey?: string; orgId?: string | null; trigger?: string } = {},
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
      `INSERT INTO workflow_runs (id, workflow_id, workflow_version, trigger, status, idempotency_key, input)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)`,
      [runId, workflowId, workflow.def.version, opts.trigger ?? 'endpoint', key, input ?? null],
    );
    return { runId, deduped: false };
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

  private validateDef(def: WorkflowDef): void {
    if (def.stages.length === 0) {
      throw new Error(`workflow ${def.id} has no stages`);
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
    }>(`SELECT id, workflow_id, status, input, trigger, org_id FROM workflow_runs WHERE id = $1`, [
      runId,
    ]);
    const run = rows[0];
    if (!run) {
      this.logger.warn({ runId }, 'run row missing; dropping job');
      return;
    }
    if (FINAL_RUN_STATES.has(run.status)) return; // idempotent re-delivery

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

  // ── stage execution ────────────────────────────────────────────────────────

  private async executeStage(args: {
    runId: string;
    workflow: RegisteredWorkflow;
    stage: WorkflowDef['stages'][number];
    resolvedInput: Record<string, unknown>;
    data: Record<string, Record<string, unknown> | undefined>;
  }): Promise<
    | { kind: 'succeeded'; output: Record<string, unknown> }
    | { kind: 'failed'; error: string }
    | { kind: 'cancelled' }
    | { kind: 'awaiting'; error?: string }
  > {
    const { runId, workflow, stage, resolvedInput, data } = args;
    const handler = this.handlers.get(stage.kind);
    if (!handler) {
      return { kind: 'failed', error: `no handler for stage kind ${stage.kind}` };
    }

    const totalAttempts = stage.retry?.attempts ?? 1;
    const backoff = stage.retry?.backoffMs ?? DEFAULT_BACKOFF_MS;
    let usesAlternative = false;

    for (let attempt = 1; ; attempt++) {
      if (await this.isCancelled(runId)) return { kind: 'cancelled' };

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
        return { kind: 'succeeded', output };
      } catch (err) {
        if (timer) clearTimeout(timer);
        const finishedAt = new Date();

        if (
          err instanceof RunCancelledError ||
          controller.signal.reason instanceof RunCancelledError
        ) {
          this.running.delete(runId);
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
          return { kind: 'cancelled' };
        }

        const timedOut = err instanceof StageTimeoutError;
        const message = (err as Error)?.message ?? String(err);

        if (attempt < totalAttempts) {
          const delay =
            backoff[Math.min(attempt - 1, backoff.length - 1)] ??
            backoff[backoff.length - 1] ??
            100;
          this.logger.warn(
            { runId, stage: stage.id, attempt, err: message },
            'stage attempt failed; retrying',
          );
          await sleep(delay);
          continue;
        }

        // Retries exhausted: consult the fallback policy when requested.
        const policy = workflow.def.fallbackPolicyId;
        const fallbackRequested = stage.onError === 'fallback' && policy !== undefined;

        if (fallbackRequested && policy === 'retry_alternative_retrieval' && !usesAlternative) {
          usesAlternative = true;
          this.logger.warn(
            { runId, stage: stage.id, policy },
            'fallback: retrying with alternative strategy',
          );
          continue;
        }

        const status = timedOut ? 'TIMED_OUT' : 'FAILED';
        await this.writeStageFailure({
          stageRunId,
          runId,
          stage,
          status,
          attempts: attempt,
          input: resolvedInput,
          error: message,
          startedAt,
          finishedAt,
        });
        await this.writeDecision({
          runId,
          stageRunId,
          workflow,
          stage,
          evidence: {
            stage: stage.id,
            failed: true,
            reason: message,
            attempt,
            policyRequested: fallbackRequested ? policy : null,
          },
          deterministic: null,
          timings: {
            startedAt: startedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            attempts: attempt,
          },
          error: { message, status },
          fallback: fallbackRequested
            ? {
                policyApplied: policy,
                action: fallbackAction(policy as string),
                stageId: stage.id,
                status,
                reasons: [message],
                attempts: attempt,
              }
            : null,
          outcome: { status },
        });

        if (!fallbackRequested) return { kind: 'failed', error: message };

        // Policies that defer to a human/channel stop the run as AWAITING; halt fails.
        if (policy === 'halt_run' || policy === 'retry_alternative_retrieval') {
          return { kind: 'failed', error: `${message} (fallback: ${policy})` };
        }
        return { kind: 'awaiting', error: `${message} (fallback: ${policy})` };
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
    stage: WorkflowDef['stages'][number];
    evidence: Record<string, unknown>;
    deterministic: Record<string, unknown> | null;
    timings: Record<string, unknown>;
    outcome?: Record<string, unknown>;
    error?: Record<string, unknown>;
    fallback?: Record<string, unknown> | null;
    adapterVersions?: Record<string, unknown>;
  }): Promise<void> {
    await this.database.query(
      `INSERT INTO decision_records
         (id, run_id, stage_run_id, workflow_id, workflow_version, module_id, module_version,
          evidence, deterministic, timings, outcome, error, fallback, adapter_versions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
