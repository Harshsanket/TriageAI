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
  | 'vectorStore'
  | 'retriever'
  | 'generator'
  | 'validator'
  | 'memory'
  | 'outputChannel'
  | 'modelRegistry';

export interface ModuleDependency {
  id: string;
  version: string; // semver subset: exact, `>=x.y.z`, `^x.y.z`
  optional?: boolean;
}

export interface CapabilityDependency {
  capability: CapabilityId | (string & {});
  minSchema?: string;
  /** Optional deps are skipped by boot validation (the consuming stage validates at runtime). */
  optional?: boolean;
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
  /** Request headers (lower-cased by the host) for signature/auth checks. */
  headers?: Record<string, string>;
  /** Raw request body when the host captured it (webhook signature checks). */
  rawBody?: string;
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
  /** Queue access so a stage can dispatch a follow-up workflow (idempotently). */
  queue: QueueCapability;
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
    /** Policy outcome when a successful stage decided *not* to proceed (Phase 5). */
    fallback?: Record<string, unknown> | null;
    /**
     * Adapter/model identities resolved at execution time (Phase 6 registry).
     * Merged over the engine's `{ handlerKind }` in `decision_records.adapter_versions`.
     */
    adapterVersions?: Record<string, unknown>;
  }>;
}

export type HealthStatus = 'healthy' | 'degraded' | 'down';

export interface HealthDetail {
  status: HealthStatus;
  detail?: string;
}

export interface EmbedResult {
  vectors: number[][];
  modelVersion: string;
}

export interface ClassificationResult {
  category: string;
  confidence: number;
  margin: number;
  method: 'zero-shot' | 'trained';
  modelVersion: string;
  scores: Array<{ category: string; score: number }>;
}

export interface VectorChunk {
  id: string;
  collection: string;
  documentId: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorMatch {
  id: string;
  documentId: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  upsert(chunks: Array<VectorChunk & { embedding: number[] }>): Promise<void>;
  search(
    collection: string,
    embedding: number[],
    opts?: { limit?: number; filter?: Record<string, unknown> },
  ): Promise<VectorMatch[]>;
  deleteByDocument(collection: string, documentId: string): Promise<void>;
}

export interface RetrievalGate {
  sufficient: boolean;
  topScore: number;
  margin: number;
  threshold: number;
  marginThreshold: number;
}

export interface RetrievalResult {
  chunks: VectorMatch[];
  gate: RetrievalGate;
}

export interface Retriever {
  search(
    collection: string,
    query: string,
    opts?: { limit?: number; filter?: Record<string, unknown> },
  ): Promise<RetrievalResult>;
}

/**
 * Outbound delivery seam (Phase 8). Concrete adapters are registered by
 * integration modules; the kernel only routes by channel id and keeps the
 * registry free of provider vocabulary (ADR-0018).
 */
export interface DeliveryContext {
  runId: string;
  workflowId: string;
  stageId: string;
  orgId: string | null;
  /** Idempotency scope for this delivery (retries must not duplicate). */
  idempotencyKey?: string;
}

export interface OutboundIntent {
  channel: string;
  title?: string;
  body: string;
  labels?: string[];
  /** Adapter-specific hints (e.g. `{ operation: 'close', issueNumber: 12 }`). */
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface DeliveryResult {
  ref: string;
  channel: string;
  deduped?: boolean;
  detail?: Record<string, unknown>;
}

export interface OutboundQuery {
  channel: string;
  text: string;
  limit?: number;
  metadata?: Record<string, unknown>;
}

export interface OutboundMatch {
  ref: string;
  title?: string;
  url?: string;
  detail?: Record<string, unknown>;
}

export interface OutputChannel {
  deliver(ctx: DeliveryContext, intent: OutboundIntent): Promise<DeliveryResult>;
  /** Optional lookup used for duplicate detection / linkbacks. */
  search?(ctx: DeliveryContext, query: OutboundQuery): Promise<OutboundMatch[]>;
}

/** Kernel-provided router; modules register one adapter per channel id. */
export interface OutputChannelRegistry extends OutputChannel {
  register(channel: string, adapter: OutputChannel): void;
  has(channel: string): boolean;
  channels(): string[];
}

export interface GenerationResult {
  text: string;
  modelVersion: string;
  usage?: { promptTokens?: number; completionTokens?: number; durationMs?: number };
}

export interface Generator {
  generate(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal },
  ): Promise<GenerationResult>;
}

export interface ValidationSource {
  ref: string;
  text: string;
}

export interface ValidatorInput {
  text: string;
  sources?: ValidationSource[];
  question?: string;
  citations?: string[];
}

export interface ValidationCheckResult {
  checkId: string;
  passed: boolean;
  reasons: string[];
}

export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheckResult[];
  redactions?: Record<string, number>;
}

/** Deterministic validation seam (Phase 5): modules add/remove/replace checks. */
export interface Validator {
  validate(input: ValidatorInput, policy?: Record<string, unknown>): Promise<ValidationReport>;
}

/**
 * Model registry seam (Phase 6): the runtime asks which asset is active for a
 * component instead of hard-coding a model name. The first implementation is
 * the host's Postgres-backed registry; a remote registry can replace it.
 */
export interface ActiveModelAsset {
  id: string;
  component: 'embedder' | 'classifier' | 'generator' | 'retriever' | (string & {});
  name: string;
  artifactRef: string | null;
  config: Record<string, unknown>;
  evalReportId: string | null;
  promotedAt: string | null;
}

export interface ModelRegistry {
  active(component: string): Promise<ActiveModelAsset | null>;
  /** Drop any cached pointer after a promotion/rollback writes a new active row. */
  invalidate?(): void;
}

/** Resolvable capability adapters (Phase 4/5: embedder, classifier, vector store, retriever, generator, validator). */
export interface Capabilities {
  embedder?: { embed(texts: string[]): Promise<EmbedResult> };
  classifier?: { classify(text: string): Promise<ClassificationResult> };
  vectorStore?: VectorStore;
  retriever?: Retriever;
  generator?: Generator;
  validator?: Validator;
  modelRegistry?: ModelRegistry;
  /** Always supplied by the kernel; integration modules register adapters. */
  outputChannel?: OutputChannelRegistry;
}

/**
 * The only way modules touch anything outside themselves (ADR-0001 §DI).
 * Capabilities are validated against the module's declared `dependsOn`.
 */
export interface KernelContext {
  moduleOptions: Record<string, unknown>;
  capabilities: Capabilities;
  database: Database;
  events: EventBus;
  queue: QueueCapability;
  logger: KernelLogger;
  registerRoute(routeDef: KernelRouteDef): void;
  registerStageHandler(kind: string, def: StageHandlerDef): void;
  /** Register a concrete OutputChannel adapter (one id per module/provider). */
  registerOutputChannel(channel: string, adapter: OutputChannel): void;
  /** Read-only process environment (secrets stay in env, never config/logs). */
  env: Readonly<Record<string, string | undefined>>;
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
  /** Host-provided capability adapters, selected by config.capabilities. */
  capabilities?: Capabilities;
}

export interface ResolvedModule {
  module: TriageModule;
  options: unknown;
}
