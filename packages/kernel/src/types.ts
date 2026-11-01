/**
 * Core kernel types. No use-case vocabulary (no "ticket", "support", "chat")
 * is allowed here — see ADR-0001. Business/feature content lives in modules.
 */
import type { ZodSchema } from 'zod';

import type { ErrorCategory, ModuleManifest, ModulePermissions } from '@triageai/contracts';
import type { ToolDefinition } from './tools/types.js';

import type { StructuredError } from './errors.js';

export type { ModuleManifest } from '@triageai/contracts';

import type { EventBus } from './eventbus.js';
import type { KnowledgeSource, KnowledgeSourceRegistry } from './sources/registry.js';

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
  | 'modelRegistry'
  | 'blobStore'
  | 'egress'
  | 'systemStatus';

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
  /** Authenticated actor (host-resolved); modules must prefer it over body input. */
  actor?: string;
  /** Host-resolved stable id of the caller; modules store it as `owner_id`. */
  actorId?: string;
  /** Host-resolved role (admin/agent/customer) for owner-or-admin rules. */
  role?: string;
  /**
   * When set, the caller may only see and act on records whose `owner_id`
   * equals this value (e.g. a customer). Modules must filter by it and answer
   * 404 — not 403 — for anything else, so ids cannot be probed.
   */
  ownerScope?: string;
  /** Request headers (lower-cased by the host) for signature/auth checks. */
  headers?: Record<string, string>;
  /** Raw request body when the host captured it (webhook signature checks). */
  rawBody?: string;
}

export type RouteHandler = (request: RouteRequest) => Promise<unknown>;

/** Generic, use-case-free job progress (Phase 20.1, ADR-0051 companion). */
export type JobStatus = 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'awaiting';

export interface JobProgressUpdate {
  done?: number;
  total?: number;
  unit?: string;
  stage?: string;
  status?: JobStatus;
  error?: string | null;
  title?: string;
  detail?: Record<string, unknown>;
}

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
  /**
   * Durable progress for long-running work (Phase 20.1). The engine stores it
   * in `job_progress`, publishes `run.progress` and marks the job terminal
   * when the run finishes.
   */
  reportProgress(update: JobProgressUpdate): Promise<void>;
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
    opts?: {
      limit?: number;
      filter?: Record<string, unknown>;
      text?: string;
      /** `public` also matches legacy chunks with no audience metadata. */
      audience?: 'public' | 'operator';
    },
  ): Promise<VectorMatch[]>;
  deleteByDocument(collection: string, documentId: string): Promise<void>;
  /** Merge metadata without re-embedding (approval/source on-off). */
  updateMetadata?(
    collection: string,
    documentId: string,
    patch: Record<string, unknown>,
  ): Promise<void>;
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
    opts?: {
      limit?: number;
      filter?: Record<string, unknown>;
      audience?: 'public' | 'operator';
    },
  ): Promise<RetrievalResult>;
  /** Drop cached results after a source/approval change (Phase 20.2). */
  invalidate?(): void;
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
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ChatRequest {
  messages: ChatMessage[];
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  toolChoice?: 'auto' | 'none' | { name: string };
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  stream?: boolean;
}
export interface ChatResponse {
  message: ChatMessage;
  toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  stopReason: 'end' | 'max_tokens' | 'tool_use' | 'content_filter' | 'error';
  modelVersion: string;
}
export interface ChatModel {
  chat(req: ChatRequest): Promise<ChatResponse>;
  describe(): {
    provider: string;
    model: string;
    hosted: boolean;
    contextWindow: number;
    maxOutput: number;
    supportsTools: boolean;
    supportsStreaming: boolean;
  };
}

export interface HostedConfig {
  enabled: boolean;
  allowedProviders: string[];
  budgets?: Record<string, { dailyTokens?: number; dailyCurrency?: number }>;
  currency?: string;
}

/** Outbound HTTP seam with an allowlist and audit (Phase 18.5). */
export interface EgressCapability {
  allows(url: string): boolean;
  fetch(
    url: string,
    init: RequestInit,
    context: { actor?: string | null; purpose: string },
  ): Promise<Response>;
}

/**
 * Read-only operational facts (ADR-0057). The host implements this from the
 * same dashboard read service the tools use; modules never read host tables.
 */
export interface SystemStatusReads {
  status(): Promise<Record<string, unknown>>;
  uptime(): Promise<Record<string, unknown>>;
  storage(): Promise<Record<string, unknown>>;
}

export interface SkillInstruction {
  name: string;
  version: number;
  content: string;
}

export interface SkillCapture {
  kind: 'explicit' | 'suggestion' | 'none';
  added: boolean;
  name: string | null;
  notice: string | null;
}

export interface SkillReadApi {
  enabled(ownerId: string | null): Promise<SkillInstruction[]>;
  capture(ownerId: string | null, text: string, actor?: string | null): Promise<SkillCapture>;
}

export interface Capabilities {
  embedder?: { embed(texts: string[]): Promise<EmbedResult> };
  chatModel?: ChatModel;
  cache?: import('./storage/cache.js').Cache;
  blobStore?: import('./storage/blob.js').BlobStore;
  egress?: EgressCapability;
  classifier?: { classify(text: string): Promise<ClassificationResult> };
  vectorStore?: VectorStore;
  retriever?: Retriever;
  generator?: Generator;
  validator?: Validator;
  modelRegistry?: ModelRegistry;
  systemStatus?: SystemStatusReads;
  /** Always supplied by the kernel; integration modules register adapters. */
  outputChannel?: OutputChannelRegistry;
}

/**
 * The only way modules touch anything outside themselves (ADR-0001 §DI).
 * Capabilities are validated against the module's declared `dependsOn`.
 */
/**
 * Core read APIs (ADR-0054 §3): modules never read kernel tables directly.
 * `runs` replaces raw `workflow_runs`/`stage_runs` queries; `audit` stamps the
 * calling module automatically.
 */
export interface RunReadFilter {
  workflowId?: string;
  status?: string[];
  /** Exact JSONB containment on the run input (`input @> inputMatch`). */
  inputMatch?: Record<string, string>;
  ownerId?: string;
  limit?: number;
}

export interface RunWithStages {
  run: import('@triageai/contracts').RunDto;
  stages: import('@triageai/contracts').StageRunDto[];
}

export interface RunReadApi {
  get(id: string): Promise<RunWithStages | null>;
  list(filter?: RunReadFilter): Promise<RunWithStages[]>;
}

export interface AuditAppendInput {
  action: string;
  subject?: string | null;
  payload?: Record<string, unknown>;
  actor?: string | null;
}

export interface CostLedgerEntry {
  runId?: string | null;
  stageId?: string | null;
  agentId?: string | null;
  task: string;
  provider: string;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  estCost?: number;
  actualCost?: number | null;
  currency?: string;
}

export interface ModelTraceRecord {
  traceId: string;
  runId: string;
  task: string;
  trace: unknown;
}

export interface KnowledgeStats {
  documents: number;
  approvedDocuments: number;
  chunks: number;
}

export interface KnowledgeStorageStats {
  chunks: number;
  textBytes: number;
  vectorBytes: number;
}

export interface KnowledgeReadApi {
  collectionHasRows(collection: string): Promise<boolean>;
  deleteCollection(collection: string): Promise<void>;
  documentStats(collection: string): Promise<KnowledgeStats>;
  dailyCounts(collection: string, days: number): Promise<Array<{ bucket: string; count: number }>>;
  /** Bytes stored for a collection: chunk text + pgvector columns (Phase 23.4). */
  storageStats(collection: string): Promise<KnowledgeStorageStats>;
}

export interface FeedbackProposal {
  source: string;
  sourceRunId?: string | null;
  input: Record<string, unknown>;
  gold: Record<string, unknown>;
  provenance: Record<string, unknown>;
  actor?: string | null;
}

export interface KernelContext {
  moduleOptions: Record<string, unknown>;
  capabilities: Capabilities;
  database: Database;
  events: EventBus;
  queue: QueueCapability;
  /** Core read APIs (ADR-0054 §3). */
  runs: RunReadApi;
  audit: { append(entry: AuditAppendInput): Promise<void> };
  settings: { get<T = unknown>(key: string): Promise<T | null> };
  /** User skills (ADR-0060): enabled instructions and deterministic capture. */
  skills: SkillReadApi;
  costLedger: {
    record(entry: CostLedgerEntry): Promise<void>;
    tokensToday(provider?: string): Promise<number>;
  };
  traces: { record(entry: ModelTraceRecord): Promise<void> };
  knowledge: KnowledgeReadApi;
  feedback: { propose(entry: FeedbackProposal): Promise<{ id: string }> };
  /** Agent work items (ADR-0031/ADR-0055 task.*); core-owned state. */
  tasks: {
    create(args: {
      workspaceId: string;
      rootRunId: string;
      title: string;
      doneWhen: string;
      inputRefs?: string[];
    }): Promise<unknown>;
    get(id: string): Promise<unknown | null>;
    claim(id: string, agentId: string, leaseMs?: number): Promise<unknown>;
    review(
      id: string,
      checkerId: string,
      args: { pass: boolean; proofRefs?: string[]; failed?: string; saw?: string; fix?: string },
    ): Promise<unknown>;
  };
  logger: KernelLogger;
  /**
   * Provide a capability implementation (ADR-0054 §4). Consumers ask for the
   * capability id; config selects which module (or the host) serves it.
   */
  provideCapability(id: CapabilityId | (string & {}), impl: unknown): void;
  /** Register the schema for an event this module publishes (ADR-0055 §4). */
  registerEventSchema(event: string, schema: ZodSchema): void;
  registerRoute(routeDef: KernelRouteDef): void;
  registerStageHandler(kind: string, def: StageHandlerDef): void;
  /** Register a tool under the mandatory tool contract (Phase 15). */
  registerTool(def: ToolDefinition<unknown, unknown>): void;
  /** Durable job progress for a run (Phase 20.1); safe before/after the run. */
  reportProgress(runId: string, update: JobProgressUpdate): Promise<void>;
  /** Register a source plugin (Phase 20.2); it only fetches items. */
  registerKnowledgeSource(source: KnowledgeSource): void;
  /** Contribute dashboard data without the host reading module tables (R13). */
  registerDashboardProvider(provider: DashboardProvider): void;
  /** Contribute Prometheus metrics without the host reading module tables (R13). */
  registerMetricsProvider(provider: MetricsProvider): void;
  /** Every registered knowledge source, including plugins. */
  knowledgeSources: KnowledgeSourceRegistry;
  /** Register a concrete OutputChannel adapter (one id per module/provider). */
  registerOutputChannel(channel: string, adapter: OutputChannel): void;
  /**
   * Optional data-retention task (Phase 9). Modules own their message bodies;
   * the kernel computes cutoffs and records what was deleted.
   */
  registerRetentionTask(task: RetentionTask): void;
  /** Read-only process environment (secrets stay in env, never config/logs). */
  env: Readonly<Record<string, string | undefined>>;
  /** IDs of every module enabled in this kernel generation. */
  enabledModules: readonly string[];
  /** Effective kernel config (read-only; no secrets). */
  config: KernelConfig;
}

export interface RetentionCutoffs {
  runs: Date | null;
  decisions: Date | null;
  audit: Date | null;
  candidates: Date | null;
  messages: Date | null;
  deadletters: Date | null;
}

export interface DashboardProvider {
  id: string;
  read(context: { database: Database }): Promise<Record<string, unknown>>;
}

export interface MetricsProvider {
  id: string;
  read(context: { database: Database }): Promise<Record<string, number>>;
}

export interface RetentionTask {
  id: string;
  apply(context: { database: Database; cutoffs: RetentionCutoffs }): Promise<number>;
}

export interface RetentionResult {
  id: string;
  deleted: number;
}

export interface RetentionReport {
  ranAt: string;
  enabled: boolean;
  cutoffs: Record<keyof RetentionCutoffs, string | null>;
  results: RetentionResult[];
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
    opts?: {
      idempotencyKey?: string;
      orgId?: string | null;
      trigger?: string;
      /** Owner for the jobs tray; defaults to the workflow's declared scope. */
      ownerId?: string | null;
      /** Human title for the jobs tray (no use-case vocabulary in the kernel). */
      title?: string;
      total?: number;
      unit?: string;
      /** Await terminal completion up to this many ms (interactive ingestion). */
      waitMs?: number;
    },
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
  /** Streaming routes set the response type (e.g. `text/event-stream`). */
  contentType?: string;
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
    retry?: {
      attempts: number;
      backoffMs?: number[];
      /** Categories to retry instead of the error's own retryable flag (per-stage override). */
      retryOn?: ErrorCategory[];
    };
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

export type ModuleRunMode = 'in-process' | 'worker' | 'container';

export interface TriageModule {
  id: string;
  version: string;
  capabilities: CapabilityId[]; // consumed capabilities (declared access)
  /**
   * Permission manifest enforced by the kernel (ADR-0054 §2). First-party
   * in-process modules may omit it (the process is the trust boundary);
   * third-party plugins must declare it, and an absent manifest denies all.
   */
  permissions?: ModulePermissions;
  /** True for packages loaded from a signed plugin archive (default deny). */
  thirdParty?: boolean;
  /** How the supervisor should run the module (ADR-0054 §6). */
  runMode?: ModuleRunMode;
  dependsOn: {
    /** Capability requirements only; module-to-module edges were removed in Phase 22. */
    capabilities?: CapabilityDependency[];
  };
  configSchema?: ZodSchema;
  manifest: ModuleManifest;
  migrations?: Migration[];
  tables?: string[];
  /** Phase 12: where the host loads the web bundle (`/plugins/<id>/<version>/web.js`). */
  bundleUrl?: string;

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
  fatal?(obj: unknown, msg?: string): void;
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
  id: string;
  queue: string;
  payload: unknown;
  attempts: number;
  error: string;
  errorDetails?: StructuredError;
  createdAt: string;
}

export interface RetentionConfig {
  enabled: boolean;
  intervalHours: number;
  runDays: number | null;
  decisionDays: number | null;
  auditDays: number | null;
  candidateDays: number | null;
  messageDays: number | null;
  deadletterDays: number | null;
}

export interface KernelConfig {
  profile: string;
  queue: { adapter: 'pg-queue' | 'inline' | 'bullmq'; pollIntervalMs?: number };
  modules: Record<string, { enabled: boolean; options?: unknown }>;
  capabilities: Record<string, { adapter: string; [key: string]: unknown }>;
  retention?: RetentionConfig;
  hosted?: HostedConfig;
  /** Host allowlist for every outbound HTTP call (18.5). */
  egress?: {
    allowlist: Array<{ host: string; dataClass: 'public' | 'internal' | 'restricted' | 'secret' }>;
  };
}

export interface KernelOptions {
  config: KernelConfig;
  modules: Record<string, TriageModule>;
  database: Database;
  logger: KernelLogger;
  /** Host-provided capability adapters, selected by config.capabilities. */
  capabilities?: Capabilities;
  /**
   * Environment modules see as `ctx.env` (credentials by env-var name). The
   * host may layer stored secrets under `process.env`; defaults to it.
   */
  env?: Record<string, string | undefined>;
}

export interface ResolvedModule {
  module: TriageModule;
  options: unknown;
}
