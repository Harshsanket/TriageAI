/**
 * Kernel boot: config + module graph → migrations → lifecycle (topological:
 * dependencies first) → HTTP route collection → workflow workers on the
 * configured queue adapter. See contracts/module-contract.md §7–8.
 */
import { ModuleInfoSchema, SystemManifestSchema } from '@triageai/contracts';
import type { ModuleInfo, SystemManifest } from '@triageai/contracts';

import { AppError, bootValidationError, configInvalid } from './errors.js';
import { createEventBus } from './eventbus.js';
import type { EventBus } from './eventbus.js';
import { CORE_MIGRATIONS } from './migrations.js';
import { createOutputChannelRegistry } from './outputChannel.js';
import { InlineQueue } from './queue/inline.js';
import { PgQueue } from './queue/pg.js';
import type { Queue } from './queue/types.js';
import { satisfiesRange } from './semver.js';
import { MIGRATIONS_TABLE_SQL, MigrationRunner } from './storage.js';
import type {
  Capabilities,
  Database,
  KernelConfig,
  KernelContext,
  KernelLogger,
  KernelOptions,
  KernelRouteDef,
  QueueCapability,
  ResolvedModule,
  RetentionConfig,
  RetentionCutoffs,
  RetentionReport,
  RetentionTask,
  StageHandlerDef,
  TriageModule,
  WorkflowDef,
} from './types.js';
import { WorkflowEngine } from './workflow.js';

const ROUTE_URL_SCHEME = /^\/[a-z0-9/_:{}.$@-]*$/i;

export interface Kernel {
  readonly config: KernelConfig;
  readonly modules: string[];
  routes(): KernelRouteDef[];
  manifest(): SystemManifest;
  infos(): ModuleInfo[];
  health(): Promise<Array<ModuleInfo & { health?: 'healthy' | 'degraded' | 'down' }>>;
  uninstallModule(id: string): Promise<{ dropped: string[] }>;
  /** Run the configured retention pass (ADR-0021); safe to call repeatedly. */
  runRetention(now?: Date): Promise<RetentionReport>;
  shutdown(): Promise<void>;
  /** Test/ops access (Phase 1; the inspector operates in Phase 2 via API). */
  readonly workflowEngine: WorkflowEngine;
  readonly queue: Queue;
  readonly events: EventBus;
  readonly database: Database;
}

function createKernelContext(
  moduleId: string,
  module: TriageModule,
  moduleOptions: Record<string, unknown>,
  capabilities: Capabilities,
  engine: WorkflowEngine,
  routes: KernelRouteDef[],
  database: Database,
  events: EventBus,
  queue: Queue,
  logger: KernelLogger,
  retentionTasks: RetentionTask[],
): KernelContext {
  const queueCapability: QueueCapability = {
    start(def: WorkflowDef) {
      if (def.module !== moduleId) {
        throw new Error(
          `workflow ${def.id} declares module ${def.module} but is registered by ${moduleId}`,
        );
      }
      engine.register(def, moduleId, module.version);
    },
    startWorkflow: async (workflowId, input, opts) => {
      const candidate = await engine.start(workflowId, input, opts);
      if (!candidate.deduped) {
        try {
          await queue.enqueue(
            'workflow.run',
            { runId: candidate.runId },
            { idempotencyKey: `run:${candidate.runId}` },
          );
        } catch (err) {
          logger.error(
            { err: (err as Error).message, runId: candidate.runId },
            'failed to enqueue run',
          );
          throw err;
        }
      }
      return candidate;
    },
    registerWorker: (queueName, handler, opts) => {
      queue.subscribe(queueName, async (payload) => handler(payload), opts);
    },
    drain: () => queue.drain(),
  };

  const outputChannel = capabilities.outputChannel;
  const context: KernelContext = {
    moduleOptions,
    capabilities,
    database,
    events,
    queue: queueCapability,
    logger,
    env: process.env,
    registerRoute(def) {
      if (!ROUTE_URL_SCHEME.test(def.url)) {
        throw new Error(`module ${moduleId} registered invalid route url ${def.url}`);
      }
      routes.push(def);
    },
    registerStageHandler(kind: string, def: StageHandlerDef) {
      engine.registerStageHandler(kind, def);
    },
    registerOutputChannel(channel, adapter) {
      if (!outputChannel) {
        throw new Error('output channel registry is not available');
      }
      outputChannel.register(channel, adapter);
    },
    registerRetentionTask(task) {
      retentionTasks.push(task);
    },
  };
  return context;
}

export async function bootKernel(options: KernelOptions): Promise<Kernel> {
  const { config, database, logger } = options;

  await database.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('kernel:migrations-table'))`);
    await tx.query(MIGRATIONS_TABLE_SQL);
  });
  const runner = new MigrationRunner(database, logger);
  const coreResult = await runner.apply('kernel', CORE_MIGRATIONS);
  const coreProblems = coreResult.conflicts.map(
    (c) =>
      `core migration ${c.id}: ${c.reason} (migrations are immutable; reset the database to re-apply from scratch)`,
  );
  if (coreProblems.length > 0) throw bootValidationError('Core migrations rejected', coreProblems);

  const resolution = resolveModules(config, options.modules);
  if (resolution.error) throw bootValidationError('Boot validation failed', resolution.error);
  const ordered = resolution.ordered;

  const capabilities: Capabilities = {
    ...(options.capabilities ?? {}),
    outputChannel: options.capabilities?.outputChannel ?? createOutputChannelRegistry(),
  };
  const capabilityProblems: string[] = [];
  for (const resolved of ordered) {
    for (const dep of resolved.module.dependsOn.capabilities ?? []) {
      if (
        dep.capability === 'storage' ||
        dep.capability === 'queue' ||
        dep.capability === 'eventBus' ||
        dep.capability === 'outputChannel'
      ) {
        continue; // always present on KernelContext
      }
      if (dep.optional) continue;
      if (
        !(dep.capability in capabilities) ||
        !capabilities[dep.capability as keyof Capabilities]
      ) {
        capabilityProblems.push(
          `module "${resolved.module.id}" requires capability "${dep.capability}", but no adapter is configured for it`,
        );
      }
    }
  }
  if (capabilityProblems.length > 0) {
    throw bootValidationError('Boot validation failed', capabilityProblems);
  }

  const events = createEventBus(logger);
  const queue: Queue =
    config.queue.adapter === 'inline' ? new InlineQueue(logger) : new PgQueue(database, logger);

  const enqueueRun = async (runId: string): Promise<void> => {
    await queue.enqueue('workflow.run', { runId }, { idempotencyKey: `run:${runId}` });
  };
  const engineRef: { current?: WorkflowEngine } = {};
  const stageQueue: QueueCapability = {
    start() {
      throw new Error('a stage can only dispatch follow-up workflows, not register definitions');
    },
    async startWorkflow(workflowId, input, opts) {
      const current = engineRef.current;
      if (!current) throw new Error('workflow engine is not initialized yet');
      const candidate = await current.start(workflowId, input, opts);
      if (!candidate.deduped) await enqueueRun(candidate.runId);
      return candidate;
    },
    registerWorker(queueName, handler, opts) {
      queue.subscribe(queueName, async (payload) => handler(payload), opts);
    },
    drain: () => queue.drain(),
  };
  const engine = new WorkflowEngine(database, logger, events, stageQueue);
  engineRef.current = engine;
  const routes: KernelRouteDef[] = [];
  const retentionTasks: RetentionTask[] = [];

  for (const resolved of ordered) {
    const module = resolved.module;
    let parsedOptions: Record<string, unknown> = {};
    if (module.configSchema) {
      const parsed = module.configSchema.safeParse(resolved.options ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `  ${module.id}.config.${i.path.join('.')}: ${i.message}`)
          .join('\n');
        throw configInvalid(
          `Invalid options for module "${module.id}":\n${issues}`,
          parsed.error.issues,
        );
      }
      parsedOptions = parsed.data as Record<string, unknown>;
    }

    if (module.migrations?.length) {
      const moduleResult = await runner.apply(module.id, module.migrations);
      const moduleProblems = moduleResult.conflicts.map(
        (c) => `module "${module.id}" migration ${c.id}: ${c.reason}`,
      );
      if (moduleProblems.length > 0) {
        throw bootValidationError(`Migrations rejected for module "${module.id}"`, moduleProblems);
      }
    }

    const context = createKernelContext(
      module.id,
      module,
      parsedOptions,
      capabilities,
      engine,
      routes,
      database,
      events,
      queue,
      logger,
      retentionTasks,
    );
    try {
      module.register(context);
      if (module.lifecycle.onEnable) await module.lifecycle.onEnable();
      if (module.lifecycle.onStart) await module.lifecycle.onStart();
      await events.publish('kernel.module.started', { id: module.id, version: module.version });
    } catch (err) {
      throw bootValidationError(`Module "${module.id}" failed during start`, [
        (err as Error).message,
      ]);
    }
  }

  queue.subscribe(
    'workflow.run',
    async (payload) => {
      const decoded = payload as { runId?: string };
      if (decoded.runId) await engine.processRun(decoded.runId);
    },
    { backoffMs: [500, 2000, 10000] },
  );

  const startedIds = ordered.map((m) => m.module.id);

  logger.info(
    { modules: startedIds, queue: config.queue.adapter, profile: config.profile },
    'kernel booted',
  );

  const manifest = (): SystemManifest =>
    SystemManifestSchema.parse({
      generatedAt: new Date().toISOString(),
      modules: ordered.map((r) => ({
        id: r.module.id,
        version: r.module.version,
        manifest: r.module.manifest,
      })),
    });

  return {
    config,
    modules: startedIds,
    routes: () => routes,
    manifest,
    infos: () =>
      ordered.map((r) =>
        ModuleInfoSchema.parse({
          id: r.module.id,
          version: r.module.version,
          status: 'enabled',
          capabilities: r.module.capabilities,
        }),
      ),
    health: async () => {
      return Promise.all(
        ordered.map(async (r) => {
          if (!r.module.lifecycle.health) {
            return ModuleInfoSchema.parse({
              id: r.module.id,
              version: r.module.version,
              status: 'enabled',
              capabilities: r.module.capabilities,
            });
          }
          const detail = await r.module.lifecycle.health();
          return ModuleInfoSchema.parse({
            id: r.module.id,
            version: r.module.version,
            status: 'enabled',
            capabilities: r.module.capabilities,
            health: detail.status,
          });
        }),
      );
    },
    runRetention: async (now = new Date()) =>
      runRetentionPass(database, config.retention ?? DEFAULT_RETENTION, retentionTasks, now),
    uninstallModule: async (id: string) => {
      if (startedIds.includes(id)) {
        throw new AppError(
          'kernel.CONFLICT',
          `module "${id}" is enabled; disable it in your config first (enabling is restart-time, ADR-0001)`,
        );
      }
      const target = options.modules[id];
      if (!target) throw new AppError('kernel.NOT_FOUND', `module "${id}" not known`);
      const dropped = await runner.uninstall(id, target.migrations ?? []);
      return { dropped };
    },
    shutdown: async () => {
      // Stop the queue first: no new work may start while modules tear down.
      await queue.close();
      for (const item of [...ordered].reverse()) {
        try {
          if (item.module.lifecycle.onStop) await item.module.lifecycle.onStop();
        } catch (err) {
          logger.warn(
            { module: item.module.id, err: (err as Error).message },
            'module stop failed',
          );
        }
      }
    },
    workflowEngine: engine,
    queue,
    events,
    database,
  };
}

export function resolveModules(
  config: KernelConfig,
  available: Record<string, TriageModule>,
): { ordered: ResolvedModule[]; error?: string[] } {
  const problems: string[] = [];
  const enabledIds = Object.entries(config.modules)
    .filter(([, mod]) => mod.enabled)
    .map(([id]) => id);

  const selected = new Set<string>();
  for (const id of enabledIds) {
    const mod = available[id];
    if (!mod) {
      problems.push(
        `module "${id}" is enabled in config but not registered (is the module installed and imported into the host?)`,
      );
      continue;
    }
    selected.add(id);
  }

  for (const id of selected) {
    const mod = available[id];
    for (const dep of mod.dependsOn.modules ?? []) {
      if (!available[dep.id]) {
        if (dep.optional) continue;
        problems.push(`module "${id}" depends on "${dep.id}" which is not registered`);
        continue;
      }
      if (!selected.has(dep.id)) {
        if (dep.optional) continue;
        problems.push(
          `module "${id}" depends on "${dep.id}" which is registered but not enabled in profile "${config.profile}"`,
        );
        continue;
      }
      const check = satisfiesRange(available[dep.id].version, dep.version);
      if (!check.ok) {
        problems.push(`module "${id}" depends on "${dep.id}" ${dep.version}: ${check.reason}`);
      }
    }
    for (const dep of mod.dependsOn.capabilities ?? []) {
      if (dep.minSchema) {
        problems.push(`module "${id}": capability schema versioning is not implemented yet`);
      }
    }
  }

  interface VisitState {
    visiting: boolean;
    visited: boolean;
  }
  const states = new Map<string, VisitState>();
  const stack: string[] = [];
  const ordered: ResolvedModule[] = [];

  const visit = (id: string): void => {
    const state = states.get(id) ?? { visiting: false, visited: false };
    if (state.visiting) {
      const cycle = [...stack.slice(stack.lastIndexOf(id)), id].join(' → ');
      problems.push(`module cycle detected: ${cycle}`);
      return;
    }
    if (state.visited) return;
    states.set(id, { visiting: true, visited: false });
    stack.push(id);
    for (const dep of available[id].dependsOn.modules ?? []) {
      if (selected.has(dep.id)) visit(dep.id);
    }
    stack.pop();
    states.set(id, { visiting: false, visited: true });
    ordered.push({ module: available[id], options: config.modules[id].options });
  };

  for (const id of selected) visit(id);

  if (problems.length > 0) return { ordered: [], error: problems };
  return { ordered };
}

export const DEFAULT_RETENTION: RetentionConfig = {
  enabled: false,
  intervalHours: 24,
  runDays: null,
  decisionDays: null,
  auditDays: null,
  candidateDays: null,
  messageDays: null,
  deadletterDays: null,
};

function cutoffFor(now: Date, days: number | null): Date | null {
  return days == null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

async function runRetentionPass(
  database: Database,
  config: RetentionConfig,
  tasks: RetentionTask[],
  now: Date,
): Promise<RetentionReport> {
  const cutoffs: RetentionCutoffs = {
    runs: cutoffFor(now, config.runDays),
    decisions: cutoffFor(now, config.decisionDays),
    audit: cutoffFor(now, config.auditDays),
    candidates: cutoffFor(now, config.candidateDays),
    messages: cutoffFor(now, config.messageDays),
    deadletters: cutoffFor(now, config.deadletterDays),
  };
  const results: Array<{ id: string; deleted: number }> = [];

  const coreDeletes: Array<{ id: string; cutoff: Date | null; sql: string }> = [
    {
      id: 'kernel.workflow_runs',
      cutoff: cutoffs.runs,
      sql: `DELETE FROM workflow_runs
            WHERE finished_at IS NOT NULL AND finished_at < $1
              AND status IN ('SUCCEEDED','FAILED','CANCELLED','AWAITING')
            RETURNING id`,
    },
    {
      id: 'kernel.decision_records',
      cutoff: cutoffs.decisions,
      sql: `DELETE FROM decision_records WHERE created_at < $1 RETURNING id`,
    },
    {
      id: 'kernel.audit_events',
      cutoff: cutoffs.audit,
      sql: `DELETE FROM audit_events WHERE created_at < $1 RETURNING id`,
    },
    {
      id: 'kernel.candidate_examples',
      cutoff: cutoffs.candidates,
      sql: `DELETE FROM candidate_examples
            WHERE created_at < $1 AND status IN ('proposed','rejected') RETURNING id`,
    },
    {
      id: 'kernel.queue_deadletters',
      cutoff: cutoffs.deadletters,
      sql: `DELETE FROM queue_deadletters WHERE created_at < $1 RETURNING id`,
    },
  ];

  for (const item of coreDeletes) {
    if (!item.cutoff) continue;
    const rows = await database.query(item.sql, [item.cutoff]);
    results.push({ id: item.id, deleted: rows.length });
  }
  for (const task of tasks) {
    try {
      const deleted = await task.apply({ database, cutoffs });
      results.push({ id: task.id, deleted });
    } catch (err) {
      // One module's retention failure must not block the others.
      results.push({ id: task.id, deleted: 0 });
      void err;
    }
  }

  return {
    ranAt: now.toISOString(),
    enabled: config.enabled,
    cutoffs: {
      runs: cutoffs.runs?.toISOString() ?? null,
      decisions: cutoffs.decisions?.toISOString() ?? null,
      audit: cutoffs.audit?.toISOString() ?? null,
      candidates: cutoffs.candidates?.toISOString() ?? null,
      messages: cutoffs.messages?.toISOString() ?? null,
      deadletters: cutoffs.deadletters?.toISOString() ?? null,
    },
    results,
  };
}
