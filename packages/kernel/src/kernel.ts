/**
 * Kernel boot: config + module graph → migrations → lifecycle (topological:
 * dependencies first) → HTTP route collection → workflow workers on the
 * configured queue adapter. See contracts/module-contract.md §7–8.
 */
import { ModuleInfoSchema, SystemManifestSchema } from '@triageai/contracts';
import type { ModuleInfo, SystemManifest } from '@triageai/contracts';

import { appendAudit, createCoreContextApis, createKnowledgeReadApi } from './coreApis.js';
import { AppError, bootValidationError, configInvalid } from './errors.js';
import {
  diffPermissions,
  GrantsEngine,
  GrantStore,
  grantDenied,
  permissionHash,
  type GrantResource,
} from './grants.js';
import { createEventBus } from './eventbus.js';
import { createOutboxEventBus, OutboxStore } from './outbox.js';
import type { EventBus } from './eventbus.js';
import { CORE_MIGRATIONS } from './migrations.js';
import { createOutputChannelRegistry } from './outputChannel.js';
import { CapabilityRouter } from './capabilityRouter.js';
import { EventSchemaRegistry } from './typedEvents.js';
import { mp1RoundTrip, serializedTransportEnabled } from './mp1/serialized.js';
import { createKnowledgeSourceRegistry } from './sources/registry.js';
import { InlineQueue } from './queue/inline.js';
import { PgQueue } from './queue/pg.js';
import type { Queue } from './queue/types.js';
import { MIGRATIONS_TABLE_SQL, MigrationRunner, lintModuleMigration } from './storage.js';
import { dropModuleStorage, provisionModuleStorage, type ModuleStorage } from './storageScope.js';
import type {
  Capabilities,
  DashboardProvider,
  Database,
  KernelConfig,
  KernelContext,
  KernelLogger,
  KernelOptions,
  KernelRouteDef,
  MetricsProvider,
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
import { ToolRegistry } from './tools/registry.js';
import { WorkItemStore } from './state/index.js';

const ROUTE_URL_SCHEME = /^\/[a-z0-9/_:{}.$@-]*$/i;

const TERMINAL_RUN_STATUS = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING']);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRun(database: Database, runId: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const rows = await database.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE id = $1`,
      [runId],
    );
    if (!rows[0] || TERMINAL_RUN_STATUS.has(rows[0].status)) return;
    await sleep(Date.now() - deadline > -2_000 ? 100 : 25);
  }
}

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
  /** Kernel-owned tool registry (Phase 15). */
  readonly tools: ToolRegistry;
  /** Persisted module grant approvals (ADR-0054 §2). */
  readonly grantStore: GrantStore;
  /** Read every dashboard provider registered by enabled modules (R13). */
  readDashboardProviders(): Promise<Record<string, unknown>[]>;
  /** Read every metrics provider registered by enabled modules (R13). */
  readMetricsProviders(): Promise<Record<string, number>[]>;
}

function createKernelContext(
  moduleId: string,
  module: TriageModule,
  moduleOptions: Record<string, unknown>,
  capabilities: Capabilities,
  router: CapabilityRouter,
  eventSchemas: EventSchemaRegistry,
  engine: WorkflowEngine,
  routes: KernelRouteDef[],
  database: Database,
  scopedDatabase: Database | null,
  events: EventBus,
  queue: Queue,
  logger: KernelLogger,
  retentionTasks: RetentionTask[],
  dashboardProviders: DashboardProvider[],
  metricsProviders: MetricsProvider[],
  env: Record<string, string | undefined>,
  enabledModules: readonly string[],
  config: KernelConfig,
  tools: ToolRegistry,
  knowledgeSources: ReturnType<typeof createKnowledgeSourceRegistry>,
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
      if (opts?.waitMs) await waitForRun(database, candidate.runId, Math.max(0, opts.waitMs));
      return candidate;
    },
    registerWorker: (queueName, handler, opts) => {
      queue.subscribe(queueName, async (payload) => handler(payload), opts);
    },
    drain: () => queue.drain(),
  };

  const outputChannel = capabilities.outputChannel;
  const coreApis = createCoreContextApis(database, moduleId);
  const moduleDatabase = scopedDatabase ?? database;
  const workItems = new WorkItemStore(database);
  const serialize = serializedTransportEnabled(env);
  const roundTrip = <T>(
    op: Parameters<typeof mp1RoundTrip>[0]['op'],
    schema: string,
    payload: unknown,
    execute: () => Promise<T>,
  ): Promise<T> =>
    serialize
      ? mp1RoundTrip<T>(
          { moduleId, moduleVersion: module.version, op, schema, payload },
          async () => execute(),
        )
      : execute();
  const moduleRuns: KernelContext['runs'] = {
    get: (id) => roundTrip('runs.get', 'mp1.runs.get@1', { id }, () => coreApis.runs.get(id)),
    list: (filter) =>
      roundTrip('runs.list', 'mp1.runs.list@1', filter ?? {}, () => coreApis.runs.list(filter)),
  };
  const moduleAudit: KernelContext['audit'] = {
    append: (entry) =>
      roundTrip(
        'audit.append',
        'mp1.audit.append@1',
        { action: entry.action, subject: entry.subject ?? null, payload: entry.payload ?? {} },
        () => coreApis.audit.append(entry),
      ),
  };
  const deny = (resource: GrantResource, name: string): void => {
    void appendAudit(database, 'kernel', {
      action: 'module.grant_denied',
      subject: moduleId,
      payload: { resource, name },
    }).catch(() => undefined);
    logger.warn({ module: moduleId, resource, name }, 'module grant denied');
  };
  const grants = new GrantsEngine(
    moduleId,
    module.permissions,
    deny,
    module.permissions === undefined && module.thirdParty !== true,
  );

  const grantedCapabilities = new Set(grants.permissions.capabilities.consume);
  const egress = router.resolve('egress') as Capabilities['egress'];
  const moduleCapabilities: Capabilities = { ...capabilities };
  if (egress) {
    moduleCapabilities.egress = {
      allows(url: string) {
        try {
          grants.assertEgress(url);
          return egress.allows(url);
        } catch {
          return false;
        }
      },
      fetch(url: string, init: RequestInit, context: { actor?: string | null; purpose: string }) {
        grants.assertEgress(url);
        return egress.fetch(url, init, context);
      },
    };
  }
  const capabilitiesProxy = new Proxy(moduleCapabilities, {
    get(target, key, receiver) {
      if (typeof key === 'string') {
        const known = key in target || router.providersFor(key).length > 0;
        if (known && !grantedCapabilities.has(key)) {
          if (!(module.permissions === undefined && module.thirdParty !== true)) {
            deny('capability.consume', key);
            throw grantDenied(moduleId, 'capability.consume', key);
          }
        }
        if (key === 'egress') return target.egress;
        if (router.providersFor(key).length > 0) return router.resolve(key);
      }
      return Reflect.get(target, key, receiver);
    },
  });

  const grantedKnowledge: KernelContext['knowledge'] = {
    async collectionHasRows(collection: string) {
      grants.assertKnowledge(collection, 'read');
      return roundTrip(
        'knowledge.query',
        'mp1.knowledge.query@1',
        { collection, mode: 'read', operation: 'hasRows' },
        () => coreApis.knowledge.collectionHasRows(collection),
      );
    },
    async deleteCollection(collection: string) {
      grants.assertKnowledge(collection, 'write');
      return roundTrip(
        'knowledge.query',
        'mp1.knowledge.query@1',
        { collection, mode: 'write', operation: 'delete' },
        () => coreApis.knowledge.deleteCollection(collection),
      );
    },
    async documentStats(collection: string) {
      grants.assertKnowledge(collection, 'read');
      return roundTrip(
        'knowledge.query',
        'mp1.knowledge.query@1',
        { collection, mode: 'read', operation: 'stats' },
        () => coreApis.knowledge.documentStats(collection),
      );
    },
    async dailyCounts(collection: string, days: number) {
      grants.assertKnowledge(collection, 'read');
      return roundTrip(
        'knowledge.query',
        'mp1.knowledge.query@1',
        { collection, mode: 'read', operation: 'dailyCounts', days },
        () => coreApis.knowledge.dailyCounts(collection, days),
      );
    },
    async storageStats(collection: string) {
      grants.assertKnowledge(collection, 'read');
      return roundTrip(
        'knowledge.query',
        'mp1.knowledge.query@1',
        { collection, mode: 'read', operation: 'storageStats' },
        () => coreApis.knowledge.storageStats(collection),
      );
    },
  };

  const moduleEvents = {
    async publish(event: string, payload: unknown) {
      grants.assertEventPublish(event);
      eventSchemas.validate(event, payload, moduleId);
      return roundTrip('event.publish', 'mp1.event.publish@1', { event, payload }, () =>
        events.publish(event, payload),
      );
    },
    subscribe(event: string, handler: (payload: unknown) => void | Promise<void>) {
      grants.assertEventSubscribe(event);
      events.subscribe(event, handler);
    },
  };

  const moduleQueue: QueueCapability = {
    ...queueCapability,
    start(def: WorkflowDef) {
      grants.assertWorkflow(def.id);
      queueCapability.start(def);
    },
    async startWorkflow(workflowId, input, opts) {
      grants.assertWorkflow(workflowId);
      return queueCapability.startWorkflow(workflowId, input, opts);
    },
  };

  const context: KernelContext = {
    moduleOptions,
    capabilities: capabilitiesProxy,
    database: moduleDatabase,
    events: moduleEvents,
    queue: moduleQueue,
    ...coreApis,
    runs: moduleRuns,
    audit: moduleAudit,
    knowledge: grantedKnowledge,
    tasks: {
      create: (args) => workItems.create(args),
      get: (id) => workItems.get(id),
      claim: (id, agentId, leaseMs) => workItems.claim(id, agentId, leaseMs),
      review: (id, checkerId, args) => workItems.review(id, checkerId, args),
    },
    logger,
    env,
    enabledModules,
    config,
    provideCapability(id, impl) {
      grants.assertCapabilityProvide(id);
      router.provide(moduleId, id, impl);
    },
    registerEventSchema(event, schema) {
      if (!event.startsWith(`${grants.eventNamespace}.`)) {
        throw grantDenied(
          moduleId,
          'event.publish',
          `${event} (namespace is ${grants.eventNamespace}.*)`,
        );
      }
      eventSchemas.register({ name: event, owner: moduleId, schema });
    },
    registerRoute(def) {
      if (!ROUTE_URL_SCHEME.test(def.url)) {
        throw new Error(`module ${moduleId} registered invalid route url ${def.url}`);
      }
      grants.assertRoute(def.method, def.url);
      routes.push(def);
    },
    registerStageHandler(kind: string, def: StageHandlerDef) {
      grants.assertStage(kind);
      engine.registerStageHandler(kind, {
        ...def,
        execute: (stage) => def.execute({ ...stage, database: moduleDatabase }),
      });
    },
    registerTool(def) {
      grants.assertTool(def.name);
      tools.register(def);
    },
    reportProgress: (runId, update) => engine.reportProgress(runId, update),
    registerKnowledgeSource(source) {
      knowledgeSources.register(source);
    },
    knowledgeSources,
    registerDashboardProvider(provider) {
      dashboardProviders.push({
        ...provider,
        read: () => provider.read({ database: moduleDatabase }),
      });
    },
    registerMetricsProvider(provider) {
      metricsProviders.push({
        ...provider,
        read: () => provider.read({ database: moduleDatabase }),
      });
    },
    registerOutputChannel(channel, adapter) {
      grants.assertCapabilityConsume('outputChannel');
      if (!outputChannel) {
        throw new Error('output channel registry is not available');
      }
      outputChannel.register(channel, adapter);
    },
    registerRetentionTask(task) {
      retentionTasks.push({
        ...task,
        apply: (context) => task.apply({ ...context, database: moduleDatabase }),
      });
    },
  };
  return context;
}

export async function bootKernel(options: KernelOptions): Promise<Kernel> {
  const { config, database, logger } = options;

  if (config.queue.adapter === 'bullmq') {
    // Accepted by the schema for forward compatibility, but no adapter exists
    // yet; failing here beats silently running pg-queue (ADR-0003).
    throw bootValidationError('Boot validation failed', [
      'queue adapter "bullmq" is not implemented yet; use "pg-queue" or "inline"',
    ]);
  }

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

  const grantStore = new GrantStore(database);
  for (const resolved of ordered) {
    const module = resolved.module;
    if (module.permissions === undefined) continue; // trusted in-process first party
    const existing = await grantStore.get(module.id);
    if (!existing) {
      if (module.thirdParty) {
        throw bootValidationError('Boot validation failed', [
          `third-party module "${module.id}" has no approved permission manifest`,
        ]);
      }
      await grantStore.approve(module, 'kernel:first-party');
      continue;
    }
    if (existing.manifestHash === permissionHash(module.permissions)) continue;
    const diff = diffPermissions(
      module.id,
      existing.version,
      module.version,
      existing.permissions,
      module.permissions,
    );
    if (module.thirdParty && diff.added.length > 0) {
      throw bootValidationError('Boot validation failed', [
        `module "${module.id}" upgrade widens grants and needs admin approval: ${diff.added.join(', ')}`,
      ]);
    }
    await grantStore.approve(module, module.thirdParty ? null : 'kernel:first-party');
  }

  const capabilities: Capabilities = {
    ...(options.capabilities ?? {}),
    outputChannel: options.capabilities?.outputChannel ?? createOutputChannelRegistry(),
  };
  const capabilityRouter = new CapabilityRouter(config, capabilities);

  const queue: Queue =
    config.queue.adapter === 'inline' ? new InlineQueue(logger) : new PgQueue(database, logger);
  const events = createOutboxEventBus({
    database,
    queue,
    local: createEventBus(logger),
    logger,
  });

  const eventSchemas = new EventSchemaRegistry();

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
      if (opts?.waitMs) await waitForRun(database, candidate.runId, Math.max(0, opts.waitMs));
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
  const tools = new ToolRegistry();
  const knowledgeSources = createKnowledgeSourceRegistry();
  const dashboardProviders: DashboardProvider[] = [];
  const metricsProviders: MetricsProvider[] = [];

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

    let storage: ModuleStorage | null = null;
    try {
      storage = await provisionModuleStorage(database, module);
    } catch (err) {
      throw bootValidationError(`Storage provisioning failed for module "${module.id}"`, [
        (err as Error).message,
      ]);
    }

    if (module.migrations?.length) {
      const lintProblems = module.migrations.flatMap((migration) =>
        lintModuleMigration(module.id, migration).map(
          (finding) => `${migration.id}: ${finding.rule} (${finding.detail})`,
        ),
      );
      if (lintProblems.length > 0) {
        throw bootValidationError(`Migrations rejected for module "${module.id}"`, lintProblems);
      }
      const moduleResult = await runner.apply(module.id, module.migrations, {
        ...(storage ? { schema: storage.schema } : {}),
      });
      const moduleProblems = moduleResult.conflicts.map(
        (c) => `module "${module.id}" migration ${c.id}: ${c.reason}`,
      );
      if (moduleProblems.length > 0) {
        throw bootValidationError(`Migrations rejected for module "${module.id}"`, moduleProblems);
      }
      if (storage) storage = await provisionModuleStorage(database, module);
    }

    const context = createKernelContext(
      module.id,
      module,
      parsedOptions,
      capabilities,
      capabilityRouter,
      eventSchemas,
      engine,
      routes,
      database,
      storage?.database ?? null,
      events,
      queue,
      logger,
      retentionTasks,
      dashboardProviders,
      metricsProviders,
      options.env ?? process.env,
      ordered.map((entry) => entry.module.id),
      config,
      tools,
      knowledgeSources,
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
      if (!capabilityRouter.has(dep.capability)) {
        capabilityProblems.push(
          `module "${resolved.module.id}" requires capability "${dep.capability}", but no adapter or provider is configured for it`,
        );
      }
    }
  }
  if (capabilityProblems.length > 0) {
    throw bootValidationError('Boot validation failed', capabilityProblems);
  }

  // Replay events committed before a crash (outbox durability, 18.3).
  const pending = await new OutboxStore(database).pending(200);
  for (const event of pending) {
    await queue.enqueue(
      'outbox.deliver',
      { id: event.id },
      { idempotencyKey: `outbox:${event.id}` },
    );
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
        ...(r.module.bundleUrl ? { bundleUrl: r.module.bundleUrl } : {}),
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
      if (target.lifecycle.onUninstall) {
        const storage = await provisionModuleStorage(database, target);
        const rawOptions = (config.modules[id]?.options ?? {}) as Record<string, unknown>;
        const parsedOptions = target.configSchema?.safeParse(rawOptions);
        await target.lifecycle.onUninstall({
          database: storage?.database ?? database,
          options: parsedOptions?.success
            ? (parsedOptions.data as Record<string, unknown>)
            : rawOptions,
          capabilities,
          knowledge: createKnowledgeReadApi(database),
        });
      }
      const schemaDrops = await dropModuleStorage(database, target);
      const dropped = await runner.uninstall(id, target.migrations ?? []);
      return { dropped: [...schemaDrops, ...dropped] };
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
    tools,
    grantStore,
    readDashboardProviders: async () => {
      const results: Record<string, unknown>[] = [];
      for (const provider of dashboardProviders) {
        try {
          results.push(await provider.read({ database }));
        } catch (err) {
          logger.warn(
            { provider: provider.id, err: (err as Error).message },
            'dashboard provider failed',
          );
        }
      }
      return results;
    },
    readMetricsProviders: async () => {
      const results: Record<string, number>[] = [];
      for (const provider of metricsProviders) {
        try {
          results.push(await provider.read({ database }));
        } catch (err) {
          logger.warn(
            { provider: provider.id, err: (err as Error).message },
            'metrics provider failed',
          );
        }
      }
      return results;
    },
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

  // ADR-0054 §4: modules depend only on capabilities and events. A module that
  // provides a capability is ordered before every selected module consuming it.
  const providerFor = new Map<string, string>();
  for (const id of selected) {
    for (const capability of available[id].permissions?.capabilities.provide ?? []) {
      providerFor.set(capability, id);
    }
  }
  const dependencies = new Map<string, Set<string>>();
  for (const id of selected) {
    const deps = new Set<string>();
    for (const capability of available[id].permissions?.capabilities.consume ?? []) {
      const provider = providerFor.get(capability);
      if (provider && provider !== id) deps.add(provider);
    }
    dependencies.set(id, deps);
  }

  for (const id of selected) {
    for (const dep of available[id].dependsOn.capabilities ?? []) {
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
    for (const dep of dependencies.get(id) ?? []) visit(dep);
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
