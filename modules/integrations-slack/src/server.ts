/**
 * Slack container entrypoint (Phase 22.T9). The core supervisor invokes the
 * module's stages over MP1; Slack itself only reaches the network through the
 * output channel, and its data stays in `mod_integrations_slack`.
 */
import {
  createOutputChannelRegistry,
  internal,
  PostgresDatabase,
  startMp1HttpServer,
} from '@triageai/kernel';
import type {
  KernelConfig,
  KernelContext,
  KernelLogger,
  StageHandlerContext,
  StageHandlerDef,
  WorkflowDef,
} from '@triageai/kernel';

import { integrationsSlackModule } from './index.js';

const MODULE_ID = 'integrations-slack';
const VERSION = '0.1.0';
const PORT = Number(process.env.TRIAGEAI_MP1_PORT ?? 8080);
const database = new PostgresDatabase(
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@postgres:5432/triageai',
);
const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const handlers = new Map<string, StageHandlerDef>();
const workflows: WorkflowDef[] = [];
let moduleOptions: Record<string, unknown> = {};
try {
  moduleOptions = JSON.parse(process.env.TRIAGEAI_MODULE_OPTIONS ?? '{}') as Record<
    string,
    unknown
  >;
} catch {
  moduleOptions = {};
}

const ctx = {
  moduleOptions,
  capabilities: { outputChannel: createOutputChannelRegistry() },
  database,
  events: { subscribe: () => undefined, publish: async () => undefined },
  queue: {
    start: (def: WorkflowDef) => workflows.push(def),
    startWorkflow: async () => ({ runId: '', deduped: true }),
    registerWorker: () => undefined,
    drain: async () => undefined,
  },
  runs: {
    get: async () => null,
    list: async () => [],
  },
  audit: { append: async () => undefined },
  settings: { get: async () => null },
  costLedger: { record: async () => undefined, tokensToday: async () => 0 },
  traces: { record: async () => undefined },
  knowledge: {
    collectionHasRows: async () => false,
    deleteCollection: async () => undefined,
    documentStats: async () => ({ documents: 0, approvedDocuments: 0, chunks: 0 }),
    dailyCounts: async () => [],
  },
  feedback: { propose: async () => ({ id: '' }) },
  logger,
  env: process.env,
  enabledModules: [MODULE_ID],
  config: {
    profile: 'modules',
    queue: { adapter: 'pg-queue' },
    modules: {},
    capabilities: {},
  } satisfies KernelConfig,
  provideCapability: () => undefined,
  registerEventSchema: () => undefined,
  registerRoute: () => undefined,
  registerStageHandler: (kind: string, def: StageHandlerDef) => handlers.set(kind, def),
  registerTool: () => undefined,
  registerOutputChannel: (channel: string, adapter: never) =>
    ctx.capabilities.outputChannel?.register(channel, adapter),
  registerRetentionTask: () => undefined,
  registerKnowledgeSource: () => undefined,
  registerDashboardProvider: () => undefined,
  registerMetricsProvider: () => undefined,
  knowledgeSources: { get: () => undefined, register: () => undefined, list: () => [] },
  reportProgress: async () => undefined,
} as unknown as KernelContext;

integrationsSlackModule.register(ctx);

const server = await startMp1HttpServer({
  moduleId: MODULE_ID,
  version: VERSION,
  port: PORT,
  requireSession: process.env.TRIAGEAI_MP1_REQUIRE_SESSION === '1',
  ...(process.env.TRIAGEAI_CORE_PUBLIC_KEY
    ? { corePublicKeyBase64: process.env.TRIAGEAI_CORE_PUBLIC_KEY }
    : {}),
  ...(process.env.TRIAGEAI_SESSION_PUBLIC_KEY
    ? {
        sessionPublicKeyBase64: process.env.TRIAGEAI_SESSION_PUBLIC_KEY,
        sessionGeneration: process.env.TRIAGEAI_SESSION_GENERATION,
      }
    : {}),
  onStop: () => void database.close(),
  handlers: {
    async handshake() {
      return {
        mp: '1.0',
        moduleId: MODULE_ID,
        version: VERSION,
        schemas: ['mp1.handshake@1', 'mp1.stage.invoke@1', 'mp1.response@1'],
        runMode: 'container',
      };
    },
    async health() {
      return integrationsSlackModule.lifecycle.health
        ? await integrationsSlackModule.lifecycle.health()
        : { status: 'healthy' };
    },
    async drain() {
      return { drained: true };
    },
    async stop() {
      await integrationsSlackModule.lifecycle.onStop?.();
      return { stopped: true };
    },
    async 'stage.invoke'(raw) {
      const payload = raw as {
        runId: string;
        workflowId: string;
        stageId: string;
        kind: string;
        config: Record<string, unknown>;
        input: Record<string, unknown>;
        data: Record<string, Record<string, unknown> | undefined>;
      };
      const handler = handlers.get(payload.kind);
      if (!handler) throw internal(`unsupported slack stage ${payload.kind}`);
      const stage: StageHandlerContext = {
        runId: payload.runId,
        orgId: null,
        workflowId: payload.workflowId,
        stageId: payload.stageId,
        config: payload.config,
        input: payload.input,
        data: payload.data,
        database,
        queue: ctx.queue,
        signal: AbortSignal.timeout(60_000),
        reportProgress: async () => undefined,
      };
      return handler.execute(stage);
    },
  },
});

console.log(JSON.stringify({ module: MODULE_ID, version: VERSION, port: server.port, mp: '1.0' }));
