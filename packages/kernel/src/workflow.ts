/**
 * Declarative workflow engine — Phase 1 transport: sequenced stage lists with
 * persisted runs/stages/decision records ([contracts/workflow-contract.md],
 * contract requirements for `when`/retry/cancel land in Phase 2).
 */
import { ulid } from 'ulid';

import type {
  Database,
  KernelLogger,
  StageHandlerDef,
  StageHandlerContext,
  WorkflowDef,
} from './types.js';

interface RegisteredWorkflow {
  def: WorkflowDef;
  moduleId: string;
  moduleVersion: string;
}

export class WorkflowEngine {
  private workflows = new Map<string, RegisteredWorkflow>();
  private handlers = new Map<string, StageHandlerDef>();

  constructor(
    private database: Database,
    private logger: KernelLogger,
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

  private validateDef(def: WorkflowDef): void {
    if (def.stages.length === 0) {
      throw new Error(`workflow ${def.id} has no stages`);
    }
    const seen = new Set<string>();
    for (const stage of def.stages) {
      if (seen.has(stage.id)) throw new Error(`workflow ${def.id}: duplicate stage id ${stage.id}`);
      seen.add(stage.id);
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
    if (run.status === 'SUCCEEDED' || run.status === 'FAILED') return; // idempotent re-delivery

    const workflow = this.workflows.get(run.workflow_id);
    if (!workflow) {
      await this.database.query(
        `UPDATE workflow_runs SET status = 'FAILED', error = 'workflow not registered', finished_at = now() WHERE id = $1`,
        [runId],
      );
      return;
    }

    await this.database.query(
      `UPDATE workflow_runs SET status = 'RUNNING', started_at = now() WHERE id = $1`,
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
    let failed = false;
    let runError: string | null = null;

    for (const stage of workflow.def.stages) {
      const stageRunId = ulid();
      const handler = this.handlers.get(stage.kind);
      if (!handler) {
        failed = true;
        runError = `no handler for stage kind ${stage.kind}`;
        break;
      }
      const startedAt = new Date();
      try {
        const contextValue: StageHandlerContext = {
          runId,
          orgId: run.org_id,
          workflowId: workflow.def.id,
          stageId: stage.id,
          config: stage.config ?? {},
          data,
          database: this.database,
        };
        const result = await handler.execute(contextValue);
        const finishedAt = new Date();
        data[stage.id] = (result.output as Record<string, unknown>) ?? {};
        await this.database.query(
          `INSERT INTO stage_runs (id, run_id, stage_id, kind, status, attempts, output, error, started_at, finished_at)
           VALUES ($1, $2, $3, $4, 'SUCCEEDED', 1, $5, NULL, $6, $7)`,
          [
            stageRunId,
            runId,
            stage.id,
            stage.kind,
            result.output ?? null,
            startedAt.toISOString(),
            finishedAt.toISOString(),
          ],
        );
        await this.database.query(
          `INSERT INTO decision_records
             (id, run_id, stage_run_id, workflow_id, workflow_version, module_id, module_version,
              evidence, deterministic, timings, error, adapter_versions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11)`,
          [
            ulid(),
            runId,
            stageRunId,
            workflow.def.id,
            workflow.def.version,
            workflow.moduleId,
            workflow.moduleVersion,
            { ...(result.evidence ?? {}), input: data.input ?? {} },
            result.output ?? {},
            {
              startedAt: startedAt.toISOString(),
              durationMs: finishedAt.getTime() - startedAt.getTime(),
            },
            { handlerKind: stage.kind },
          ],
        );
      } catch (err) {
        const finishedAt = new Date();
        failed = true;
        runError = (err as Error).message;
        await this.database.query(
          `INSERT INTO stage_runs (id, run_id, stage_id, kind, status, attempts, output, error, started_at, finished_at)
           VALUES ($1, $2, $3, $4, 'FAILED', 1, NULL, $5, $6, $7)`,
          [
            stageRunId,
            runId,
            stage.id,
            stage.kind,
            runError,
            startedAt.toISOString(),
            finishedAt.toISOString(),
          ],
        );
        await this.database.query(
          `INSERT INTO decision_records
             (id, run_id, stage_run_id, workflow_id, workflow_version, module_id, module_version,
              evidence, deterministic, timings, error, adapter_versions)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            ulid(),
            runId,
            stageRunId,
            workflow.def.id,
            workflow.def.version,
            workflow.moduleId,
            workflow.moduleVersion,
            { stage: stage.id },
            null,
            {
              startedAt: startedAt.toISOString(),
              durationMs: finishedAt.getTime() - startedAt.getTime(),
            },
            { stage: stage.id, error: runError },
            { handlerKind: stage.kind },
          ],
        );
        break;
      }
    }

    if (failed) {
      await this.database.query(
        `UPDATE workflow_runs SET status = 'FAILED', error = $2, finished_at = now() WHERE id = $1`,
        [runId, runError],
      );
      this.logger.error({ runId, err: runError }, 'run failed');
      return;
    }

    const outputs: Record<string, Record<string, unknown> | undefined> = {};
    for (const stage of workflow.def.stages) outputs[stage.id] = data[stage.id];
    await this.database.query(
      `UPDATE workflow_runs SET status = 'SUCCEEDED', output = $2, finished_at = now() WHERE id = $1`,
      [runId, outputs],
    );
    this.logger.info({ runId, workflow: workflow.def.id }, 'run succeeded');
  }
}
