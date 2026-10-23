/**
 * Core kernel types. No use-case vocabulary (no "ticket", "support", "chat")
 * is allowed here — see ADR-0001. Business/feature content lives in modules.
 */
import type { ZodSchema } from 'zod';

import type { ModuleManifest } from '@triageai/contracts';

export type { ModuleManifest } from '@triageai/contracts';

import type { EventBus } from './eventbus.js';

export type CapabilityId =
  | 'storage'
  | 'queue'
  | 'eventBus'
  | 'embedder'
  | 'classifier'
  | 'retriever'
  | 'generator'
  | 'validator'
  | 'memory'
  | 'outputChannel';

export interface ModuleDependency {
  id: string;
  version: string; // semver subset: exact, `>=x.y.z`, `^x.y.z`
  optional?: boolean;
}

export interface CapabilityDependency {
  capability: CapabilityId | (string & {});
  minSchema?: string;
}

export interface Migration {
  /** Stable id. A different checksum for the same id fails the boot. */
  id: string;
  sql: string;
  /** Executed on explicit uninstall (modules only; never for core). */
  dropSql?: string;
}

export interface RouteRequest {
  method: string;
  url: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export type RouteHandler = (request: RouteRequest) => Promise<unknown>;

export interface StageHandlerContext {
  runId: string;
  orgId: string | null;
  workflowId: string;
  stageId: string;
  /** Stage config constants from the workflow definition. */
  config: Record<string, unknown>;
  /** Resolved stage input (from the `input` refs mapping). */
  input: Record<string, unknown>;
  /** Typed dataflow store: `data['input']` plus prior stage outputs by stage id. */
  data: Record<string, Record<string, unknown> | undefined>;
  database: Database;
  /** Aborted on timeout or run cancellation — adapters must honour it. */
  signal: AbortSignal;
}

export interface StageHandlerDef {
  inputSchema?: ZodSchema;
  outputSchema?: ZodSchema;
  execute(input: StageHandlerContext): Promise<{
    output?: unknown;
    evidence?: Record<string, unknown>;
    /** Deterministic inputs captured for the decision record (ADR-0005). */
    deterministic?: Record<string, unknown> | null;
  }>;
}

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface HealthDetail {
  status: HealthStatus;
  detail?: string;
}

/**
 * The only way modules touch anything outside themselves (ADR-0001 §DI).
 * Capabilities are validated against the module's declared `dependsOn`.
 */
export interface KernelContext {
  moduleOptions: Record<string, unknown>;
  database: Database;
  events: EventBus;
  queue: QueueCapability;
  logger: KernelLogger;
  registerRoute(routeDef: KernelRouteDef): void;
  registerStageHandler(kind: string, def: StageHandlerDef): void;
}

export interface QueueStartResult {
  runId: string;
  deduped: boolean;
}

/**
 * Workflow-facing queue capability: modules start workflows / register
 * deferred workers; all execution flows through the kernel executor.
 */
export interface QueueCapability {
  start(def: WorkflowDef): void;
  startWorkflow(
    workflowId: string,
    input: unknown,
    opts?: { idempotencyKey?: string; orgId?: string | null; trigger?: string },
  ): Promise<QueueStartResult>;
  /** Deferred module work outside workflows (rare in Phase 1). */
  registerWorker(
    queue: string,
    handler: (payload: unknown) => Promise<void>,
    opts?: QueueOptions,
  ): void;
  /** Wait for in-flight work to finish (graceful shutdown). */
  drain(): Promise<void>;
}

export interface KernelRouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  url: string;
  handler: RouteHandler;
}

export interface WorkflowDef {
  id: string; // '<module>.<purpose>'
  version: string;
  module: string;
  trigger: { type: 'endpoint' | 'manual' | 'event' | 'schedule'; config?: Record<string, unknown> };
  stages: Array<{
    id: string;
    kind: string;
    /** Dataflow mapping: dotted paths like `$.text` resolve from run input, `$.stages.<id>.output.<f>` from prior stages. */
    input?: Record<string, unknown>;
    config?: Record<string, unknown>;
    /** Skip-condition (grammar: docs/contracts/workflow-contract.md §3). */
    when?: string;
    /** Per-stage retries (total attempts = attempts). */
    retry?: { attempts: number; backoffMs?: number[] };
    /** Per-attempt timeout; aborts the handler signal. */
    timeoutMs?: number;
    /** Failure behavior: halt the run (default) or hand over to the fallback policy. */
    onError?: 'halt' | 'fallback';
  }>;
  fallbackPolicyId?: string;
  /** Workflow-level config constants (validated by the owning module). */
  config?: Record<string, unknown>;
}

export interface Migration {
  migrations?: Migration[];
}

export interface TriageModule {
  id: string;
  version: string;
  capabilities: CapabilityId[]; // consumed capabilities (declared access)
  dependsOn: {
    modules?: ModuleDependency[];
    capabilities?: CapabilityDependency[];
  };
  configSchema?: ZodSchema;
  manifest: ModuleManifest;
  migrations?: Migration[];
  tables?: string[];

  lifecycle: {
    onInstall?(): Promise<void>;
    onEnable?(): Promise<void>;
    onDisable?(): Promise<void>;
    onStart?(): Promise<void>;
    onStop?(): Promise<void>;
    health?(): Promise<HealthDetail>;
  };

  register(ctx: KernelContext): void;
}

export interface KernelLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Database {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<Array<T>>;
  transaction<T>(fn: (tx: TxDatabase) => Promise<T>): Promise<T>;
}

export type TxDatabase = Pick<Database, 'query'>;

export interface QueueOptions {
  concurrency?: number;
  retries?: number;
  backoffMs?: number[];
  pollIntervalMs?: number;
}

export interface DeadLetterEntry {
  queue: string;
  payload: unknown;
  attempts: number;
  error: string;
  createdAt: string;
}

export interface KernelConfig {
  profile: string;
  queue: { adapter: 'pg-queue' | 'inline' | 'bullmq'; pollIntervalMs?: number };
  modules: Record<string, { enabled: boolean; options?: unknown }>;
  capabilities: Record<string, { adapter: string; [key: string]: unknown }>;
}

export interface KernelOptions {
  config: KernelConfig;
  modules: Record<string, TriageModule>;
  database: Database;
  logger: KernelLogger;
}

export interface ResolvedModule {
  module: TriageModule;
  options: unknown;
}
