/**
 * Capability adapters for the support/assistant profiles: HTTP clients to the
 * local ai-service/generator runtimes + pgvector storage. Selected by
 * `config.capabilities`; modules only ever see `ctx.capabilities` (ADR-0012/0013).
 */
import { AiClassifyResponseSchema, AiEmbedResponseSchema } from '@triageai/contracts';
import { runValidation } from '@triageai/rag';
import type {
  Capabilities,
  ClassificationResult,
  Database,
  EmbedResult,
  Generator,
  KernelConfig,
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

export class HttpEmbedder {
  constructor(private readonly baseUrl: string) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    const res = await fetch(`${this.baseUrl}/ai/v1/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ai-service embed failed (${res.status})`);
    return AiEmbedResponseSchema.parse(await res.json());
  }
}

export class HttpClassifier {
  constructor(private readonly baseUrl: string) {}

  async classify(text: string): Promise<ClassificationResult> {
    const res = await fetch(`${this.baseUrl}/ai/v1/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ai-service classify failed (${res.status})`);
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
      await this.database.query(
        `INSERT INTO vector_chunks (collection, id, document_id, text, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)
         ON CONFLICT (collection, id) DO UPDATE
           SET document_id = EXCLUDED.document_id,
               text = EXCLUDED.text,
               metadata = EXCLUDED.metadata,
               embedding = EXCLUDED.embedding,
               updated_at = now()`,
        [
          chunk.collection,
          chunk.id,
          chunk.documentId,
          chunk.text,
          chunk.metadata ?? {},
          `[${chunk.embedding.join(',')}]`,
        ],
      );
    }
  }

  async search(
    collection: string,
    embedding: number[],
    opts: { limit?: number; filter?: Record<string, unknown> } = {},
  ): Promise<VectorMatch[]> {
    const rows = (await this.database.query(
      `SELECT id, document_id, text, metadata,
              1 - (embedding <=> $2::vector) AS score
       FROM vector_chunks
       WHERE collection = $1 AND ($3::jsonb IS NULL OR metadata @> $3::jsonb)
       ORDER BY embedding <=> $2::vector
       LIMIT $4`,
      [collection, `[${embedding.join(',')}]`, opts.filter ?? null, opts.limit ?? 5],
    )) as unknown as VectorRow[];
    return rows.map((row) => ({
      id: row.id,
      documentId: row.document_id,
      text: row.text,
      score: Number(row.score),
      metadata: row.metadata,
    }));
  }

  async deleteByDocument(collection: string, documentId: string): Promise<void> {
    await this.database.query(
      `DELETE FROM vector_chunks WHERE collection = $1 AND document_id = $2`,
      [collection, documentId],
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
}

export class PgRetriever implements Retriever {
  constructor(
    private readonly embedder: { embed(texts: string[]): Promise<EmbedResult> },
    private readonly vectorStore: VectorStore,
    private readonly threshold = 0.35,
    private readonly marginThreshold = 0.05,
    private readonly collections: Record<string, CollectionGateConfig> = {},
  ) {}

  async search(
    collection: string,
    query: string,
    opts: { limit?: number; filter?: Record<string, unknown> } = {},
  ): Promise<RetrievalResult> {
    const embedded = await this.embedder.embed([query]);
    const chunks = await this.vectorStore.search(collection, embedded.vectors[0] as number[], {
      limit: opts.limit ?? 5,
      filter: opts.filter,
    });
    const topScore = chunks[0]?.score ?? 0;
    const runnerUp = chunks[1]?.score ?? 0;
    const margin = topScore - runnerUp;
    const overrides = this.collections[collection];
    const threshold = overrides?.threshold ?? this.threshold;
    const marginThreshold = overrides?.margin ?? this.marginThreshold;
    return {
      chunks,
      gate: {
        sufficient: topScore >= threshold && margin >= marginThreshold,
        topScore,
        margin,
        threshold,
        marginThreshold,
      },
    };
  }
}

/** Ollama native API (/api/generate, non-streaming). */
export class OllamaGenerator implements Generator {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<{ text: string; modelVersion: string; usage?: Record<string, number> }> {
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: false,
        options: { num_predict: opts.maxTokens ?? 384, temperature: opts.temperature ?? 0.2 },
      }),
      signal: opts.signal ?? AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama generate failed (${res.status})`);
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
  ) {}

  async generate(
    prompt: string,
    opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<{ text: string; modelVersion: string }> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
    });
    if (!res.ok) throw new Error(`generator failed (${res.status})`);
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

function requireModel(adapter: string, model: unknown): string {
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error(`capability adapter "${adapter}" requires a config-bound "model"`);
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

export function createCapabilities(
  config: KernelConfig,
  fallbackBaseUrl: string,
  database: Database,
): Capabilities {
  const capabilities: Capabilities = { validator: new DeterministicValidator() };
  const cfg = config.capabilities;
  const aiBase = (adapterConfig: Record<string, unknown> | undefined): string =>
    (adapterConfig?.baseUrl as string | undefined) ?? fallbackBaseUrl;

  if (cfg.embedder) {
    if (cfg.embedder.adapter !== 'ai-service') {
      throw new Error(
        `unsupported embedder adapter "${cfg.embedder.adapter}" (supported: ai-service)`,
      );
    }
    capabilities.embedder = new HttpEmbedder(aiBase(cfg.embedder));
  }
  if (cfg.classifier) {
    if (cfg.classifier.adapter !== 'ai-service') {
      throw new Error(
        `unsupported classifier adapter "${cfg.classifier.adapter}" (supported: ai-service)`,
      );
    }
    capabilities.classifier = new HttpClassifier(aiBase(cfg.classifier));
  }
  if (cfg.vectorStore) {
    if (cfg.vectorStore.adapter !== 'pgvector') {
      throw new Error(
        `unsupported vectorStore adapter "${cfg.vectorStore.adapter}" (supported: pgvector)`,
      );
    }
    capabilities.vectorStore = new PgVectorStore(database);
  }
  if (cfg.retriever) {
    if (cfg.retriever.adapter !== 'pgvector') {
      throw new Error(
        `unsupported retriever adapter "${cfg.retriever.adapter}" (supported: pgvector)`,
      );
    }
    if (!capabilities.embedder || !capabilities.vectorStore) {
      throw new Error('retriever requires embedder + vectorStore adapters to be configured');
    }
    capabilities.retriever = new PgRetriever(
      capabilities.embedder,
      capabilities.vectorStore,
      (cfg.retriever.threshold as number | undefined) ?? 0.35,
      (cfg.retriever.margin as number | undefined) ?? 0.05,
      (cfg.retriever.collections as Record<string, CollectionGateConfig> | undefined) ?? {},
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
      throw new Error(
        `unsupported generator adapter "${adapter}" (ollama | lmstudio | openai_compatible_local)`,
      );
    }
  }
  return capabilities;
}
