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
  configInvalid,
  fetchFailure,
  httpFailure,
} from '@triageai/kernel';
import { runValidation } from '@triageai/rag';

import { assertHostedAllowed, buildChatModel } from './chatModels.js';
import { EgressClient } from './egress.js';
import { getControls } from './controls.js';
import { isRuntimeDisabled, runtimeIdFor } from './modelRuntimes.js';
import type {
  Capabilities,
  ChatModel,
  ChatRequest,
  ChatResponse,
  ClassificationResult,
  Database,
  EmbedResult,
  Generator,
  KernelConfig,
  ModelRegistry,
  RetrievalResult,
  Retriever,
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

export class HttpEmbedder {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/ai/v1/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    }).catch((error: unknown) => failNetwork(error, 'ai', 'ai-service'));
    if (!res.ok) await failResponse(res, 'ai', 'ai-service');
    return AiEmbedResponseSchema.parse(await res.json());
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
      embedding: number[];
    }>,
  ): Promise<void> {
    for (const chunk of chunks) {
      const dims = chunk.embedding.length;
      const model =
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
    } = {},
  ): Promise<VectorMatch[]> {
    const limit = opts.limit ?? 5;
    const vectorLiteral = `[${embedding.join(',')}]`;
    // Hybrid (18.T9/13.T7): vector + full-text candidates fused with RRF. The
    // HNSW index is only available for 384-dimension embeddings; other sizes
    // keep the exact scan.
    if (opts.text && embedding.length === 384) {
      const rows = (await this.database.query(
        `WITH vec AS (
           SELECT id, ROW_NUMBER() OVER (
             ORDER BY embedding::vector(384) <=> $2::vector(384)
           ) AS rank
           FROM vector_chunks
           WHERE collection = $1 AND dims = 384
             AND ($3::jsonb IS NULL OR metadata @> $3::jsonb)
             AND ($6::text IS NULL OR metadata->>'audience' = $6 OR NOT (metadata ? 'audience'))
           ORDER BY embedding::vector(384) <=> $2::vector(384)
           LIMIT $4
         ), kw AS (
           SELECT id, ROW_NUMBER() OVER (
             ORDER BY ts_rank_cd(to_tsvector('english', text), plainto_tsquery('english', $5)) DESC
           ) AS rank
           FROM vector_chunks
           WHERE collection = $1 AND dims = 384
             AND ($3::jsonb IS NULL OR metadata @> $3::jsonb)
             AND ($6::text IS NULL OR metadata->>'audience' = $6 OR NOT (metadata ? 'audience'))
             AND to_tsvector('english', text) @@ plainto_tsquery('english', $5)
           LIMIT $4
         ), fused AS (
           SELECT COALESCE(v.id, k.id) AS id,
                  COALESCE(1.0 / (60 + v.rank), 0) + COALESCE(1.0 / (60 + k.rank), 0) AS rrf
           FROM vec v FULL OUTER JOIN kw k USING (id)
         )
         SELECT vc.id, vc.document_id, vc.text, vc.metadata,
                1 - (vc.embedding::vector(384) <=> $2::vector(384)) AS score
         FROM fused f JOIN vector_chunks vc ON vc.collection = $1 AND vc.id = f.id
         ORDER BY f.rrf DESC, score DESC
         LIMIT $4`,
        [collection, vectorLiteral, opts.filter ?? null, limit, opts.text, opts.audience ?? null],
      )) as unknown as VectorRow[];
      return rows.map(toMatch);
    }
    const rows = (await this.database.query(
      `SELECT id, document_id, text, metadata,
              1 - (embedding <=> $2::vector) AS score
       FROM vector_chunks
       WHERE collection = $1 AND ($3::jsonb IS NULL OR metadata @> $3::jsonb)
         AND ($5::text IS NULL OR metadata->>'audience' = $5 OR NOT (metadata ? 'audience'))
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [collection, vectorLiteral, opts.filter ?? null, limit, opts.audience ?? null],
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
    const authority = chunk.metadata.approved === true ? 1 : 0.7;
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
    } = {},
  ): Promise<RetrievalResult> {
    const cacheKey = `retrieval:g${this.generation}:${collection}:${opts.limit ?? 5}:${createHash(
      'sha256',
    )
      .update(JSON.stringify({ query, filter: opts.filter ?? {}, audience: opts.audience ?? null }))
      .digest('hex')}`;
    const cached = await this.cache?.get<RetrievalResult>(cacheKey);
    if (cached) return cached;
    const embedded = await this.embedder.embed([query]);
    const requested = opts.limit ?? 5;
    const candidates = await this.vectorStore.search(collection, embedded.vectors[0] as number[], {
      limit: Math.max(requested * 4, 20),
      filter: opts.filter,
      text: query,
      audience: opts.audience,
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
  }
}

/** Ollama native API (/api/generate, non-streaming). */
export class OllamaGenerator implements Generator {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<{ text: string; modelVersion: string; usage?: Record<string, number> }> {
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
  ) {}

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<{ text: string; modelVersion: string }> {
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

class PooledChatModel implements ChatModel {
  private current: ChatModel | null = null;

  constructor(
    private readonly entries: Array<{ id: string; hosted: boolean; model: ChatModel }>,
    private readonly database: Database,
  ) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const controls = await getControls(this.database);
    for (const entry of this.entries) {
      if (isRuntimeDisabled(controls, entry.id)) continue;
      if (entry.hosted && controls.hostedModelsDisabled) continue;
      this.current = entry.model;
      return entry.model.chat(request);
    }
    throw new AppError('models.DISABLED', 'no enabled model runtime is available', undefined, 503, {
      category: 'policy_blocked',
      retryable: false,
      userMessage: 'AI generation is turned off.',
    });
  }

  describe(): ReturnType<ChatModel['describe']> {
    return (
      (this.current ?? this.entries[0]?.model)?.describe() ?? {
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

function requireModel(adapter: string, model: unknown): string {
  if (typeof model !== 'string' || model.length === 0) {
    throw configInvalid(`capability adapter "${adapter}" requires a config-bound "model"`);
  }
  return model;
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
  config: KernelConfig,
  fallbackBaseUrl: string,
  database: Database,
  modelRegistry?: ModelRegistry,
): Capabilities {
  const capabilities: Capabilities = {
    validator: new DeterministicValidator(),
    cache: new MemoryCache(),
    blobStore: new FilesystemBlobStore(
      process.env.TRIAGEAI_BLOB_ROOT ??
        resolve(process.env.TRIAGEAI_DATA_DIR ?? process.cwd(), 'data/blobs'),
    ),
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
  if (cfg.generator) {
    const adapter = cfg.generator.adapter;
    const model = requireModel(adapter, cfg.generator.model);
    // Deployment override wins over the config file: local `pnpm dev` uses
    // localhost, the compose stack uses `http://ollama:11434`, and an external
    // runtime can be any reachable URL.
    const generatorBaseUrl =
      process.env.TRIAGEAI_GENERATOR_BASE_URL ?? (cfg.generator.baseUrl as string | undefined);
    if (adapter === 'ollama') {
      capabilities.generator = new OllamaGenerator(
        generatorBaseUrl ?? 'http://localhost:11434',
        model,
      );
    } else if (adapter === 'lmstudio' || adapter === 'openai_compatible_local') {
      capabilities.generator = new OpenAICompatibleGenerator(
        generatorBaseUrl ?? 'http://localhost:1234/v1',
        model,
        (cfg.generator.apiKey as string | undefined) ?? 'local',
      );
    } else {
      throw configInvalid(
        `unsupported generator adapter "${adapter}" (ollama | lmstudio | openai_compatible_local)`,
      );
    }
  }
  const hosted = config.hosted ?? { enabled: false, allowedProviders: [] };
  const runtimeRows = Array.isArray(cfg.runtimes)
    ? (cfg.runtimes as Array<Record<string, unknown>>)
    : [];
  if (runtimeRows.length > 0) {
    const entries: Array<{ id: string; hosted: boolean; model: ChatModel }> = [];
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
      entries.push({
        id,
        hosted: ['anthropic', 'openai', 'google', 'openai_compatible'].includes(adapter),
        model: new GuardedChatModel(built, database, id),
      });
    }
    if (entries.length > 0) capabilities.chatModel = new PooledChatModel(entries, database);
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
