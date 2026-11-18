/**
 * Capability adapters for the support/assistant profiles: HTTP clients to the
 * local ai-service/generator runtimes + pgvector storage. Selected by
 * `config.capabilities`; modules only ever see `ctx.capabilities` (ADR-0012/0013).
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { AiClassifyResponseSchema, AiEmbedResponseSchema } from '@triageai/contracts';
import {
  AppError,
  FilesystemBlobStore,
  MemoryCache,
  RedisCache,
  S3BlobStore,
  chooseModel,
  configInvalid,
  estimateCostFromPrices,
  fetchFailure,
  httpFailure,
  parseBlobStoreAdapterConfig,
  parseCacheAdapterConfig,
} from '@triageai/kernel';
import { runValidation } from '@triageai/rag';

import { logger } from '../platform/logger.js';
import { assertHostedAllowed, buildChatModel } from './chatModels.js';
import { EgressClient } from './egress.js';
import { getControls, type Controls } from './controls.js';
import { isRuntimeDisabled, runtimeIdFor } from './modelRuntimes.js';
import type {
  BlobStore,
  Cache,
  Capabilities,
  ChatModel,
  ChatRequest,
  ChatResponse,
  ClassificationResult,
  Database,
  EmbedResult,
  Generator,
  KernelConfig,
  KernelLogger,
  ModelOption,
  ModelRegistry,
  RetrievalResult,
  Retriever,
  RoutingConfig,
  RoutingPriceEntry,
  RoutingTaskRoute,
  ValidationReport,
  Validator,
  ValidatorInput,
  VectorMatch,
  VectorStore,
} from '@triageai/kernel';

const AI_TIMEOUT_MS = 15_000;
const GENERATION_TIMEOUT_MS = 120_000;

/** Read the failure body once and map the status/Retry-After to the taxonomy. */
async function failResponse(res: Response, codePrefix: string, label: string): Promise<never> {
  const body = await res.text().catch(() => '');
  throw httpFailure({
    codePrefix,
    label,
    status: res.status,
    retryAfter: res.headers.get('retry-after'),
    body,
  });
}

function failNetwork(error: unknown, codePrefix: string, label: string): never {
  throw fetchFailure({ codePrefix, label, cause: error });
}

interface EmbedCacheEntry {
  vector: number[];
  modelVersion: string;
}

export class HttpEmbedder {
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly cache: import('@triageai/kernel').Cache = new MemoryCache(5_000),
  ) {}

  private key(text: string): string {
    return `embed:${this.baseUrl}:${createHash('sha256').update(text).digest('hex')}`;
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const results = new Array<EmbedCacheEntry | undefined>(texts.length);
    const missing: Array<{ index: number; text: string }> = [];
    for (const [index, text] of texts.entries()) {
      const cached = await this.cache.get<EmbedCacheEntry>(this.key(text));
      if (cached) {
        this.hits += 1;
        results[index] = cached;
      } else {
        this.misses += 1;
        missing.push({ index, text });
      }
    }
    if (missing.length > 0) {
      const res = await this.fetchImpl(`${this.baseUrl}/ai/v1/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: missing.map((entry) => entry.text) }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      }).catch((error: unknown) => failNetwork(error, 'ai', 'ai-service'));
      if (!res.ok) await failResponse(res, 'ai', 'ai-service');
      const parsed = AiEmbedResponseSchema.parse(await res.json());
      for (const [offset, entry] of missing.entries()) {
        const vector = parsed.vectors[offset];
        if (!vector) continue;
        const cached = { vector, modelVersion: parsed.modelVersion };
        results[entry.index] = cached;
        await this.cache.set(this.key(entry.text), cached, 24 * 60 * 60 * 1000);
      }
      return {
        vectors: results.map((entry) => entry?.vector ?? []),
        modelVersion: parsed.modelVersion,
      };
    }
    return {
      vectors: results.map((entry) => entry?.vector ?? []),
      modelVersion: results[0]?.modelVersion ?? 'cache',
    };
  }

  stats(): { hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return { hits: this.hits, misses: this.misses, hitRate: total === 0 ? 1 : this.hits / total };
  }
}

/**
 * Classifier adapter. It forwards the active registry pointer (Phase 7) so a
 * promoted linear-probe artifact becomes the serving backend on the next run;
 * the similarity default is used when no trained asset is active.
 */
export class HttpClassifier {
  constructor(
    private readonly baseUrl: string,
    private readonly modelRegistry?: ModelRegistry,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async classify(text: string): Promise<ClassificationResult> {
    const active = await this.modelRegistry?.active('classifier');
    const kind = active?.config?.kind;
    const model =
      active && kind === 'linear-probe' && active.artifactRef
        ? { name: active.name, artifactRef: active.artifactRef, kind }
        : undefined;
    const res = await this.fetchImpl(`${this.baseUrl}/ai/v1/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(model ? { text, model } : { text }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    }).catch((error: unknown) => failNetwork(error, 'ai', 'ai-service'));
    if (!res.ok) await failResponse(res, 'ai', 'ai-service');
    return AiClassifyResponseSchema.parse(await res.json());
  }
}

interface VectorRow {
  [key: string]: unknown;
  id: string;
  document_id: string;
  text: string;
  metadata: Record<string, unknown>;
  score: number;
}

/**
 * Inline a collection/model as a SQL literal: planner-time constants let
 * Postgres use the per-(collection, model, dims) partial HNSW index, which a
 * parameterised predicate cannot guarantee under generic plans. Single quotes
 * are doubled, so values from config/modules cannot break out.
 */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** pgvector-backed VectorStore (exact cosine scan; dimension-agnostic column). */
export class PgVectorStore implements VectorStore {
  constructor(private readonly database: Database) {}

  async upsert(
    chunks: Array<{
      id: string;
      collection: string;
      documentId: string;
      text: string;
      metadata?: Record<string, unknown>;
      embeddingModel?: string;
      embedding: number[];
    }>,
  ): Promise<void> {
    for (const chunk of chunks) {
      const dims = chunk.embedding.length;
      // Prefer the explicit model (embedder result) over older metadata keys.
      const model =
        chunk.embeddingModel ??
        (chunk.metadata?.embeddingModel as string | undefined) ??
        (chunk.metadata?.modelVersion as string | undefined) ??
        'default';
      await this.database.query(
        `INSERT INTO vector_chunks
           (collection, id, document_id, text, metadata, embedding, dims, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)
         ON CONFLICT (collection, id) DO UPDATE
           SET document_id = EXCLUDED.document_id,
               text = EXCLUDED.text,
               metadata = EXCLUDED.metadata,
               embedding = EXCLUDED.embedding,
               dims = EXCLUDED.dims,
               embedding_model = EXCLUDED.embedding_model,
               updated_at = now()`,
        [
          chunk.collection,
          chunk.id,
          chunk.documentId,
          chunk.text,
          chunk.metadata ?? {},
          `[${chunk.embedding.join(',')}]`,
          dims,
          model,
        ],
      );
    }
  }

  async search(
    collection: string,
    embedding: number[],
    opts: {
      limit?: number;
      filter?: Record<string, unknown>;
      text?: string;
      audience?: 'public' | 'operator';
      model?: string;
      hybrid?: boolean;
    } = {},
  ): Promise<VectorMatch[]> {
    const limit = opts.limit ?? 5;
    // Every read is scoped to the model that produced the query embedding;
    // two 384-dim models in one collection must never share neighbours.
    const model = sqlLiteral(opts.model ?? 'default');
    const scope = sqlLiteral(collection);
    const dims = embedding.length;
    const vectorLiteral = `[${embedding.join(',')}]`;
    // Hybrid (18.T9/13.T7): vector + full-text candidates fused with RRF.
    // `hybrid: false` keeps the same filters but skips the keyword leg, which
    // is the vector-only baseline of the retrieval eval A/B.
    if (opts.hybrid !== false && opts.text) {
      const rows = (await this.database.query(
        `WITH vec AS (
           SELECT id, ROW_NUMBER() OVER (
             ORDER BY embedding::vector(${dims}) <=> $1::vector(${dims})
           ) AS rank
           FROM vector_chunks
           WHERE collection = ${scope} AND dims = ${dims} AND embedding_model = ${model}
             AND ($2::jsonb IS NULL OR metadata @> $2::jsonb)
             AND ($5::text IS NULL OR metadata->>'audience' = $5 OR NOT (metadata ? 'audience'))
           ORDER BY embedding::vector(${dims}) <=> $1::vector(${dims})
           LIMIT $3
         ), kw AS (
           SELECT id, ROW_NUMBER() OVER (
             ORDER BY ts_rank_cd(to_tsvector('english', text), plainto_tsquery('english', $4)) DESC
           ) AS rank
           FROM vector_chunks
           WHERE collection = ${scope} AND dims = ${dims} AND embedding_model = ${model}
             AND ($2::jsonb IS NULL OR metadata @> $2::jsonb)
             AND ($5::text IS NULL OR metadata->>'audience' = $5 OR NOT (metadata ? 'audience'))
             AND to_tsvector('english', text) @@ plainto_tsquery('english', $4)
           LIMIT $3
         ), fused AS (
           SELECT COALESCE(v.id, k.id) AS id,
                  COALESCE(1.0 / (60 + v.rank), 0) + COALESCE(1.0 / (60 + k.rank), 0) AS rrf
           FROM vec v FULL OUTER JOIN kw k USING (id)
         )
         SELECT vc.id, vc.document_id, vc.text, vc.metadata,
                1 - (vc.embedding::vector(${dims}) <=> $1::vector(${dims})) AS score
         FROM fused f
         JOIN vector_chunks vc
           ON vc.collection = ${scope} AND vc.embedding_model = ${model} AND vc.id = f.id
         ORDER BY f.rrf DESC, score DESC
         LIMIT $3`,
        [vectorLiteral, opts.filter ?? null, limit, opts.text, opts.audience ?? null],
      )) as unknown as VectorRow[];
      return rows.map(toMatch);
    }
    const rows = (await this.database.query(
      `SELECT id, document_id, text, metadata,
              1 - (embedding <=> $1::vector) AS score
       FROM vector_chunks
       WHERE collection = ${scope} AND embedding_model = ${model}
         AND ($2::jsonb IS NULL OR metadata @> $2::jsonb)
         AND ($4::text IS NULL OR metadata->>'audience' = $4 OR NOT (metadata ? 'audience'))
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [vectorLiteral, opts.filter ?? null, limit, opts.audience ?? null],
    )) as unknown as VectorRow[];
    return rows.map(toMatch);
  }

  async deleteByDocument(collection: string, documentId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM vector_chunks WHERE collection = $1 AND document_id = $2`,
      [collection, documentId],
    );
  }

  async updateMetadata(
    collection: string,
    documentId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await this.database.query(
      `UPDATE vector_chunks SET metadata = metadata || $3::jsonb, updated_at = now()
       WHERE collection = $1 AND document_id = $2`,
      [collection, documentId, patch],
    );
  }
}

/**
 * Retriever = embed query → vector search → sufficiency gate (τ on the top
 * score and δ on the top−runner-up margin). Both KB search and RAG workflows
 * consume this single implementation.
 */
export interface CollectionGateConfig {
  threshold?: number;
  margin?: number;
  /** Lexical re-rank (opt-in per collection); a cross-encoder can replace it later. */
  rerank?: boolean;
  maxAgeDays?: number;
  freshnessWeight?: number;
  authorityWeight?: number;
}

function toMatch(row: VectorRow): VectorMatch {
  return {
    id: row.id,
    documentId: row.document_id,
    text: row.text,
    score: Number(row.score),
    metadata: row.metadata,
  };
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/** Deterministic lexical re-rank + freshness + source authority (13.T7 v1). */
function rerankChunks(
  chunks: VectorMatch[],
  query: string,
  _collection: string,
  config: CollectionGateConfig | undefined,
): VectorMatch[] {
  if (config?.rerank !== true || chunks.length === 0) return chunks;
  const queryTokens = tokens(query);
  const now = Date.now();
  const maxAgeDays = config?.maxAgeDays ?? 365;
  const freshnessWeight = config?.freshnessWeight ?? 0.1;
  const authorityWeight = config?.authorityWeight ?? 0.1;
  const scored = chunks.map((chunk) => {
    const chunkTokens = tokens(chunk.text);
    let overlap = 0;
    for (const token of queryTokens) if (chunkTokens.has(token)) overlap += 1;
    const lexical = queryTokens.size === 0 ? 0 : overlap / queryTokens.size;
    const updated = chunk.metadata.updatedAt
      ? new Date(String(chunk.metadata.updatedAt)).getTime()
      : now;
    const ageDays = Math.max(0, (now - updated) / 86_400_000);
    const freshness = ageDays > maxAgeDays ? 0.5 : 1;
    const authority = 1;
    const combined =
      chunk.score * (1 - freshnessWeight - authorityWeight) +
      lexical * 0.6 +
      freshness * freshnessWeight +
      authority * authorityWeight;
    return { chunk, combined };
  });
  return scored
    .sort((a, b) => b.combined - a.combined)
    .map(({ chunk, combined }) => ({
      ...chunk,
      score: Number(Math.min(1, combined).toFixed(4)),
    }));
}

export class PgRetriever implements Retriever {
  private generation = 0;

  constructor(
    private readonly embedder: { embed(texts: string[]): Promise<EmbedResult> },
    private readonly vectorStore: VectorStore,
    private readonly threshold = 0.35,
    private readonly marginThreshold = 0.05,
    private readonly collections: Record<string, CollectionGateConfig> = {},
    private readonly cache?: import('@triageai/kernel').Cache,
  ) {}

  async search(
    collection: string,
    query: string,
    opts: {
      limit?: number;
      filter?: Record<string, unknown>;
      audience?: 'public' | 'operator';
      hybrid?: boolean;
    } = {},
  ): Promise<RetrievalResult> {
    const hybrid = opts.hybrid ?? true;
    const cacheKey = `retrieval:g${this.generation}:${collection}:${opts.limit ?? 5}:${
      hybrid ? 'hybrid' : 'vector'
    }:${createHash('sha256')
      .update(JSON.stringify({ query, filter: opts.filter ?? {}, audience: opts.audience ?? null }))
      .digest('hex')}`;
    const cached = await this.cache?.get<RetrievalResult>(cacheKey);
    if (cached) return cached;
    const embedded = await this.embedder.embed([query]);
    const requested = opts.limit ?? 5;
    const candidates = await this.vectorStore.search(collection, embedded.vectors[0] as number[], {
      limit: Math.max(requested * 4, 20),
      filter: opts.filter,
      // The keyword leg only exists in hybrid mode; vector-only keeps the same
      // model/filter scope but skips fusion (eval baseline).
      text: hybrid ? query : undefined,
      audience: opts.audience,
      model: embedded.modelVersion,
      hybrid,
    });
    const chunks = rerankChunks(candidates, query, collection, this.collections[collection]).slice(
      0,
      requested,
    );
    const topScore = chunks[0]?.score ?? 0;
    const runnerUp = chunks[1]?.score ?? 0;
    const margin = topScore - runnerUp;
    const overrides = this.collections[collection];
    const threshold = overrides?.threshold ?? this.threshold;
    const marginThreshold = overrides?.margin ?? this.marginThreshold;
    const result: RetrievalResult = {
      chunks,
      gate: {
        sufficient: topScore >= threshold && margin >= marginThreshold,
        topScore,
        margin,
        threshold,
        marginThreshold,
      },
    };
    await this.cache?.set(cacheKey, result, 60 * 60 * 1000);
    return result;
  }

  invalidate(): void {
    this.generation += 1;
    // Retrieval and generation share the host cache. Dropping it here means a
    // disabled/deleted source cannot be served from a cached answer or chunk
    // list after the switch flips.
    void Promise.resolve(this.cache?.clear?.()).catch(() => undefined);
  }
}

/** Ollama native API (/api/generate, non-streaming). */
export class OllamaGenerator implements Generator {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    /** 14.T1: when the runtime inventory has this model, generate() wraps it. */
    private readonly chatModel?: ChatModel,
  ) {}

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<{ text: string; modelVersion: string; usage?: Record<string, number> }> {
    if (this.chatModel) {
      // Generator wraps ChatModel (14.T1): one user message, temperature and
      // token budget pass through, the runtime's kill switch still applies.
      const response = await this.chatModel.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: opts.maxTokens ?? 384,
        temperature: opts.temperature,
        signal: opts.signal ?? AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      return {
        text: response.message.content,
        modelVersion: response.modelVersion,
        usage: {
          completionTokens: response.usage.outputTokens,
          promptTokens: response.usage.inputTokens,
        },
      };
    }
    const res = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: { num_predict: opts.maxTokens ?? 384, temperature: opts.temperature ?? 0.2 },
      }),
      signal: opts.signal ?? AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    }).catch((error: unknown) => failNetwork(error, 'ollama', 'ollama'));
    if (!res.ok) await failResponse(res, 'ollama', 'ollama');
    const body = (await res.json()) as {
      response?: string;
      model?: string;
      eval_count?: number;
      prompt_eval_count?: number;
      total_duration?: number;
    };
    return {
      text: body.response ?? '',
      modelVersion: body.model ?? this.model,
      usage: {
        completionTokens: body.eval_count ?? 0,
        promptTokens: body.prompt_eval_count ?? 0,
        durationMs: Math.round((body.total_duration ?? 0) / 1_000_000),
      },
    };
  }
}

/** OpenAI-compatible local server (LM Studio, vLLM, llama.cpp server, …). */
export class OpenAICompatibleGenerator implements Generator {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey = 'local',
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    /** 14.T1: when the runtime inventory has this model, generate() wraps it. */
    private readonly chatModel?: ChatModel,
  ) {}

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<{ text: string; modelVersion: string }> {
    if (this.chatModel) {
      // Generator wraps ChatModel (14.T1): single user message with the same
      // temperature/maxTokens defaults as the legacy HTTP path.
      const response = await this.chatModel.chat({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: opts.maxTokens ?? 384,
        temperature: opts.temperature,
        signal: opts.signal ?? AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
      return {
        text: response.message.content,
        modelVersion: response.modelVersion,
      };
    }
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: opts.maxTokens ?? 384,
        temperature: opts.temperature ?? 0.2,
        stream: false,
      }),
      signal: opts.signal ?? AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    }).catch((error: unknown) => failNetwork(error, 'lmstudio', 'lmstudio'));
    if (!res.ok) await failResponse(res, 'lmstudio', 'lmstudio');
    const body = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      modelVersion: body.model ?? this.model,
    };
  }
}

/** Kill-switch guard (ADR-0058): no outbound model request while off. */
class GuardedChatModel implements ChatModel {
  constructor(
    private readonly inner: ChatModel,
    private readonly database: Database,
    private readonly id: string,
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const controls = await getControls(this.database);
    if (isRuntimeDisabled(controls, this.id)) {
      throw new AppError(
        'models.DISABLED',
        `model runtime ${this.id} is disabled by the operator`,
        { runtime: this.id },
        503,
        {
          category: 'policy_blocked',
          retryable: false,
          userMessage: 'AI generation is turned off.',
        },
      );
    }
    return this.inner.chat(request);
  }

  describe(): ReturnType<ChatModel['describe']> {
    return this.inner.describe();
  }
}

class GuardedGenerator implements Generator {
  constructor(
    private readonly inner: Generator,
    private readonly database: Database,
    private readonly id: string,
  ) {}

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<Awaited<ReturnType<Generator['generate']>>> {
    const controls = await getControls(this.database);
    if (isRuntimeDisabled(controls, this.id)) {
      throw new AppError(
        'models.DISABLED',
        `model runtime ${this.id} is disabled by the operator`,
        { runtime: this.id },
        503,
        {
          category: 'policy_blocked',
          retryable: false,
          userMessage: 'AI generation is turned off.',
        },
      );
    }
    return this.inner.generate(prompt, opts);
  }
}

/** One runtime in the pool: config inventory id + its guarded ChatModel. */
export interface RuntimeChatEntry {
  id: string;
  adapter: string;
  model: string;
  hosted: boolean;
  chatModel: ChatModel;
}

/** Optional per-call hint supplied by `callModel` deps `resolveModel` (19.2). */
export interface ChatRouteHint {
  task?: string;
  stepName?: string;
}

export interface PoolRoutingOptions {
  /** Task → route table from `config.routing.tasks`. */
  routes: Record<string, RoutingTaskRoute>;
  /** Price table from `config.routing.prices` (`provider:model` → USD/1K). */
  prices?: Record<string, RoutingPriceEntry>;
  logger?: KernelLogger;
}

const SWITCH_MODEL_CATEGORIES: ReadonlySet<AppError['category']> = new Set([
  'timeout',
  'rate_limited',
  'dependency_unavailable',
]);

/**
 * The runtime pool (25.T5, 19.2): enabled runtimes only; when the caller names
 * a task with a configured route, kernel `chooseModel` scores the options
 * (egress precedence, then cost/quality); without a task the first enabled
 * runtime serves. A failing hosted call switches once to a local runtime
 * (`switch_model`, 14.T3).
 */
export class PooledChatModel implements ChatModel {
  private current: ChatModel | null = null;
  private routingReason: string | null = null;

  constructor(
    private readonly entries: RuntimeChatEntry[],
    private readonly database: Database,
    private readonly routing: PoolRoutingOptions = { routes: {} },
  ) {}

  /** Why the last `chat()` picked its runtime, or null when unrouted. */
  get lastRoutingReason(): string | null {
    return this.routingReason;
  }

  /**
   * Resolver seam for `callModel` deps (`resolveModel`) — the pool is
   * resolver-ready; module wiring is a follow-up. Returns a task-bound view so
   * the pool can still route inside `chat()` (a bare pool reference would
   * never receive the task).
   */
  resolve(task: string, stepName?: string): { chatModel: ChatModel; reason: string } {
    const route = this.routing.routes[task];
    return {
      chatModel: new TaskBoundChatModel(this, { task, stepName }),
      reason: route ? `route:${task}` : 'pool_first_enabled',
    };
  }

  async chat(request: ChatRequest, hint?: ChatRouteHint): Promise<ChatResponse> {
    const controls = await getControls(this.database);
    const entry = this.selectEntry(controls, hint?.task);
    this.current = entry.chatModel;
    try {
      return await entry.chatModel.chat(request);
    } catch (err) {
      // switch_model (14.T3): hosted outage/rate limit → one local retry.
      if (entry.hosted && err instanceof AppError && SWITCH_MODEL_CATEGORIES.has(err.category)) {
        const local = this.entries.find(
          (candidate) =>
            candidate !== entry && !candidate.hosted && !isRuntimeDisabled(controls, candidate.id),
        );
        if (local) {
          this.routing.logger?.warn(
            { from: entry.id, to: local.id, code: err.code },
            'switch_model:hosted_to_local',
          );
          this.routingReason = 'switch_model_hosted_to_local';
          this.current = local.chatModel;
          return local.chatModel.chat(request);
        }
      }
      throw err;
    }
  }

  private selectEntry(controls: Controls, task?: string): RuntimeChatEntry {
    const enabled = this.entries.filter(
      (entry) =>
        !isRuntimeDisabled(controls, entry.id) && !(entry.hosted && controls.hostedModelsDisabled),
    );
    if (enabled.length === 0) {
      throw new AppError(
        'models.DISABLED',
        'no enabled model runtime is available',
        undefined,
        503,
        {
          category: 'policy_blocked',
          retryable: false,
          userMessage: 'AI generation is turned off.',
        },
      );
    }
    this.routingReason = null;
    const route = task ? this.routing.routes[task] : undefined;
    if (!route) return enabled[0] as RuntimeChatEntry;

    // Cost cap (19.2), enforced here: a priced option over the budget is out
    // of the running even as `primary`; unpriced options stay because missing
    // price data must not silently reroute (no data → configured primary).
    const maxCostPerCall = route.maxCostPerCall;
    const withinBudget =
      maxCostPerCall === undefined
        ? enabled
        : enabled.filter((entry) => {
            const price = this.routing.prices?.[`${entry.adapter}:${entry.model}`];
            return price?.outputPer1k === undefined || price.outputPer1k <= maxCostPerCall;
          });
    const decision = chooseModel({
      route: {
        primary: route.primary,
        fallback: route.fallback,
        qualityFloor: route.qualityFloor ?? 0,
      },
      options: withinBudget.map((entry): ModelOption => ({
        provider: entry.adapter,
        model: entry.model,
        // The runtime inventory carries no tier/quality measurements yet
        // (19.2): inventing either would let the router skip `primary`.
        tier: 'small',
        quality: undefined,
        costPer1k: this.routing.prices?.[`${entry.adapter}:${entry.model}`]?.outputPer1k,
        egress: entry.hosted ? 'hosted' : 'local',
        enabled: true,
      })),
      taskSensitivity: route.sensitivity ?? 'internal',
    });
    const picked = decision.option
      ? withinBudget.find(
          (entry) =>
            entry.adapter === decision.option?.provider && entry.model === decision.option?.model,
        )
      : undefined;
    if (picked) {
      this.routingReason = decision.reason;
      return picked;
    }
    // Egress precedence (19.2): a restricted/secret task never falls back to a
    // hosted runtime, even when that is the configured primary.
    if (route.sensitivity === 'restricted' || route.sensitivity === 'secret') {
      const local = withinBudget.find((entry) => !entry.hosted);
      if (local) return local;
      throw new AppError(
        'models.EGRESS_BLOCKED',
        `task "${task}" is ${route.sensitivity} and no local model runtime is enabled`,
        { task, sensitivity: route.sensitivity },
        403,
        {
          category: 'policy_blocked',
          retryable: false,
          userMessage: 'No local AI runtime is available for this data.',
        },
      );
    }
    return enabled[0] as RuntimeChatEntry;
  }

  describe(): ReturnType<ChatModel['describe']> {
    return (
      (this.current ?? this.entries[0]?.chatModel)?.describe() ?? {
        provider: 'none',
        model: 'none',
        hosted: false,
        contextWindow: 0,
        maxOutput: 0,
        supportsTools: false,
        supportsStreaming: false,
      }
    );
  }
}

/** Task-bound view returned by `PooledChatModel.resolve` (19.2). */
class TaskBoundChatModel implements ChatModel {
  constructor(
    private readonly pool: PooledChatModel,
    private readonly hint: ChatRouteHint,
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    return this.pool.chat(request, this.hint);
  }

  describe(): ReturnType<ChatModel['describe']> {
    return this.pool.describe();
  }
}

export interface RoutingPriceTable {
  prices?: Record<string, RoutingPriceEntry>;
}

/**
 * Price-table estimate (19.3 v1): delegates to the kernel helper
 * (`estimateCostFromPrices`) so modules and the host share one arithmetic:
 * `input × inPer1k + output × outPer1k`, per 1K tokens; cached input tokens
 * are free. Unknown models estimate to 0 until they get a price row — never
 * an invented price.
 */
export function estimateCostFromRouting(
  routing: RoutingPriceTable | undefined,
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
  tokensCached: number,
): number {
  return estimateCostFromPrices(routing?.prices, {
    provider,
    model,
    tokensIn,
    tokensOut,
    tokensCached,
  });
}

function requireModel(adapter: string, model: unknown): string {
  if (typeof model !== 'string' || model.length === 0) {
    throw configInvalid(`capability adapter "${adapter}" requires a config-bound "model"`);
  }
  return model;
}

/**
 * `capabilities.cache` selection (18.T11): memory by default; Redis when the
 * operator names it and the configured env carries a URL. A missing URL is a
 * boot error, not a silent in-memory fallback — the deployment asked for a
 * shared cache and would otherwise get per-process results.
 */
export function createCacheAdapter(
  config: Pick<KernelConfig, 'capabilities'>,
  env: NodeJS.ProcessEnv = process.env,
): Cache {
  const cache = parseCacheAdapterConfig(config.capabilities.cache);
  if (cache.adapter === 'memory') return new MemoryCache(cache.maxEntries);
  const url = env[cache.urlEnv];
  if (!url) {
    throw configInvalid(`cache adapter "redis" needs env ${cache.urlEnv} (redis://host:port)`);
  }
  return new RedisCache({ url, namespace: cache.namespace });
}

/**
 * `capabilities.blobStore` selection (18.T12): filesystem by default; the
 * S3-compatible adapter reads endpoint/credentials from the configured env
 * names so secrets stay out of triage.config.json.
 */
export function createBlobStoreAdapter(
  config: Pick<KernelConfig, 'capabilities'>,
  env: NodeJS.ProcessEnv = process.env,
): BlobStore {
  const blob = parseBlobStoreAdapterConfig(config.capabilities.blobStore);
  if (blob.adapter === 'filesystem') {
    const root =
      env.TRIAGEAI_BLOB_ROOT ?? resolve(env.TRIAGEAI_DATA_DIR ?? process.cwd(), blob.root);
    return new FilesystemBlobStore(root);
  }
  const missing = [blob.endpointEnv, blob.accessKeyEnv, blob.secretKeyEnv].filter(
    (name) => !env[name],
  );
  if (missing.length > 0) {
    throw configInvalid(`blobStore adapter "s3" needs env ${missing.join(', ')}`);
  }
  return new S3BlobStore({
    bucket: blob.bucket,
    endpoint: env[blob.endpointEnv] as string,
    accessKey: env[blob.accessKeyEnv] as string,
    secretKey: env[blob.secretKeyEnv] as string,
    region: blob.region,
  });
}

/** Deterministic validation stack; checks live in @triageai/rag (ADR-0002). */
export class DeterministicValidator implements Validator {
  async validate(
    input: ValidatorInput,
    policy: Record<string, unknown> = {},
  ): Promise<ValidationReport> {
    return runValidation(
      {
        text: input.text,
        sources: input.sources,
        question: input.question,
        citations: input.citations,
      },
      policy,
    );
  }
}

function cacheProvider(
  config: KernelConfig,
): Array<{ host: string; dataClass: 'public' | 'internal' | 'restricted' | 'secret' }> {
  const allowed = [...(config.egress?.allowlist ?? [])];
  const provider = String(config.capabilities.chatModel?.adapter ?? '');
  const hosts: Record<string, string> = {
    anthropic: 'api.anthropic.com',
    openai: 'api.openai.com',
    google: 'generativelanguage.googleapis.com',
    openai_compatible: String(config.capabilities.chatModel?.baseUrl ?? ''),
  };
  const host = hosts[provider];
  if (host) {
    try {
      allowed.push({ host: new URL(host).hostname, dataClass: 'internal' });
    } catch {
      allowed.push({ host, dataClass: 'internal' });
    }
  }
  return allowed;
}

export function createCapabilities(
  config: KernelConfig & { routing?: RoutingConfig },
  fallbackBaseUrl: string,
  database: Database,
  modelRegistry?: ModelRegistry,
): Capabilities {
  const capabilities: Capabilities = {
    validator: new DeterministicValidator(),
    cache: createCacheAdapter(config),
    blobStore: createBlobStoreAdapter(config),
    egress: new EgressClient(database, [
      ...(config.egress?.allowlist ?? []),
      ...cacheProvider(config),
    ]),
    ...(modelRegistry ? { modelRegistry } : {}),
  };
  const cfg = config.capabilities;
  const aiBase = (adapterConfig: Record<string, unknown> | undefined): string =>
    (adapterConfig?.baseUrl as string | undefined) ?? fallbackBaseUrl;

  if (cfg.embedder) {
    if (cfg.embedder.adapter !== 'ai-service') {
      throw configInvalid(
        `unsupported embedder adapter "${cfg.embedder.adapter}" (supported: ai-service)`,
      );
    }
    capabilities.embedder = new HttpEmbedder(aiBase(cfg.embedder));
  }
  if (cfg.classifier) {
    if (cfg.classifier.adapter !== 'ai-service') {
      throw configInvalid(
        `unsupported classifier adapter "${cfg.classifier.adapter}" (supported: ai-service)`,
      );
    }
    capabilities.classifier = new HttpClassifier(aiBase(cfg.classifier), modelRegistry);
  }
  if (cfg.vectorStore) {
    if (cfg.vectorStore.adapter !== 'pgvector') {
      throw configInvalid(
        `unsupported vectorStore adapter "${cfg.vectorStore.adapter}" (supported: pgvector)`,
      );
    }
    capabilities.vectorStore = new PgVectorStore(database);
  }
  if (cfg.retriever) {
    if (cfg.retriever.adapter !== 'pgvector') {
      throw configInvalid(
        `unsupported retriever adapter "${cfg.retriever.adapter}" (supported: pgvector)`,
      );
    }
    if (!capabilities.embedder || !capabilities.vectorStore) {
      throw configInvalid('retriever requires embedder + vectorStore adapters to be configured');
    }
    capabilities.retriever = new PgRetriever(
      capabilities.embedder,
      capabilities.vectorStore,
      (cfg.retriever.threshold as number | undefined) ?? 0.35,
      (cfg.retriever.margin as number | undefined) ?? 0.05,
      (cfg.retriever.collections as Record<string, CollectionGateConfig> | undefined) ?? {},
      capabilities.cache,
    );
  }
  const hosted = config.hosted ?? { enabled: false, allowedProviders: [] };
  const runtimeRows = Array.isArray(cfg.runtimes)
    ? (cfg.runtimes as Array<Record<string, unknown>>)
    : [];
  // Build every runtime ChatModel once, before the Generator seam, so the pool
  // and a wrapping Generator share one guarded instance (14.T1).
  const runtimeEntries: RuntimeChatEntry[] = [];
  for (const row of runtimeRows) {
    const adapter = String(row.adapter ?? '');
    const model = String(row.model ?? '');
    if (!adapter || !model) continue;
    assertHostedAllowed({ adapter, hosted });
    const apiKeyEnv =
      (row.apiKeyEnv as string | undefined) ??
      {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        google: 'GOOGLE_API_KEY',
        openai_compatible: 'OPENAI_API_KEY',
      }[adapter] ??
      undefined;
    const built = buildChatModel({
      adapter,
      model,
      baseUrl: row.baseUrl as string | undefined,
      apiKey: apiKeyEnv ? process.env[apiKeyEnv] : undefined,
      contextWindow: row.contextWindow as number | undefined,
      maxOutput: row.maxOutput as number | undefined,
      egress: capabilities.egress,
    });
    const id = String(row.id ?? runtimeIdFor(adapter, model));
    runtimeEntries.push({
      id,
      adapter,
      model,
      hosted: ['anthropic', 'openai', 'google', 'openai_compatible'].includes(adapter),
      chatModel: new GuardedChatModel(built, database, id),
    });
  }
  if (cfg.generator) {
    const adapter = cfg.generator.adapter;
    const model = requireModel(adapter, cfg.generator.model);
    // Deployment override wins over the config file: local `pnpm dev` uses
    // localhost, the compose stack uses `http://ollama:11434`, and an external
    // runtime can be any reachable URL.
    const generatorBaseUrl =
      process.env.TRIAGEAI_GENERATOR_BASE_URL ?? (cfg.generator.baseUrl as string | undefined);
    // 14.T1: when the inventory has the same runtime, the Generator wraps its
    // (kill-switched) ChatModel instead of re-implementing the wire protocol;
    // the runtime's baseUrl is authoritative. Without a match the legacy
    // direct-HTTP path stays.
    const delegate = runtimeEntries.find(
      (entry) => entry.adapter === adapter && entry.model === model,
    );
    if (adapter === 'ollama') {
      capabilities.generator = new OllamaGenerator(
        generatorBaseUrl ?? 'http://localhost:11434',
        model,
        undefined,
        delegate?.chatModel,
      );
    } else if (adapter === 'lmstudio' || adapter === 'openai_compatible_local') {
      capabilities.generator = new OpenAICompatibleGenerator(
        generatorBaseUrl ?? 'http://localhost:1234/v1',
        model,
        (cfg.generator.apiKey as string | undefined) ?? 'local',
        undefined,
        delegate?.chatModel,
      );
    } else {
      throw configInvalid(
        `unsupported generator adapter "${adapter}" (ollama | lmstudio | openai_compatible_local)`,
      );
    }
  }
  if (runtimeRows.length > 0) {
    if (runtimeEntries.length > 0) {
      capabilities.chatModel = new PooledChatModel(runtimeEntries, database, {
        routes: config.routing?.tasks ?? {},
        prices: config.routing?.prices,
        logger,
      });
    }
  } else if (cfg.chatModel) {
    const adapter = String(cfg.chatModel.adapter);
    const model = String(cfg.chatModel.model ?? '');
    if (!model) throw configInvalid(`chatModel adapter "${adapter}" needs a model`);
    assertHostedAllowed({ adapter, hosted });
    const apiKeyEnv =
      (cfg.chatModel.apiKeyEnv as string | undefined) ??
      {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        google: 'GOOGLE_API_KEY',
        openai_compatible: 'OPENAI_API_KEY',
      }[adapter] ??
      undefined;
    const built = buildChatModel({
      adapter,
      model,
      baseUrl: cfg.chatModel.baseUrl as string | undefined,
      apiKey: apiKeyEnv ? process.env[apiKeyEnv] : undefined,
      contextWindow: cfg.chatModel.contextWindow as number | undefined,
      maxOutput: cfg.chatModel.maxOutput as number | undefined,
      egress: capabilities.egress,
    });
    capabilities.chatModel = new GuardedChatModel(
      built,
      database,
      runtimeIdFor(adapter, model, cfg.chatModel.id ? String(cfg.chatModel.id) : undefined),
    );
  } else if (cfg.generator) {
    // Local Generator remains the compatibility seam; expose the same runtime
    // as a ChatModel so new stages share one implementation (Phase 14).
    const adapter = String(cfg.generator.adapter);
    const model = String(cfg.generator.model ?? '');
    const baseUrl =
      process.env.TRIAGEAI_GENERATOR_BASE_URL ?? (cfg.generator.baseUrl as string | undefined);
    if (adapter === 'ollama') {
      capabilities.chatModel = new GuardedChatModel(
        buildChatModel({ adapter: 'ollama', model, baseUrl, egress: capabilities.egress }),
        database,
        runtimeIdFor(adapter, model),
      );
    } else if (adapter === 'lmstudio' || adapter === 'openai_compatible_local') {
      capabilities.chatModel = new GuardedChatModel(
        buildChatModel({ adapter, model, baseUrl, egress: capabilities.egress }),
        database,
        runtimeIdFor(adapter, model),
      );
    }
  }
  if (capabilities.generator) {
    const generatorConfig = (cfg.generator ?? {}) as Record<string, unknown>;
    const adapter = String(generatorConfig.adapter ?? 'generator');
    const model = String(generatorConfig.model ?? '');
    capabilities.generator = new GuardedGenerator(
      capabilities.generator,
      database,
      runtimeIdFor(adapter, model),
    );
  }
  return capabilities;
}
