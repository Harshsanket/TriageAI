/**
 * 16.T5 agent memory tools. Agents propose entries through `memory.create`
 * (validated, sourced, ≤300 chars) and retrieve them just in time through
 * `memory.search`. Both are scoped to the calling agent/workspace; vector
 * embeddings are optional and degrade to lexical recall when unavailable.
 */
import { z } from 'zod';

import { policyBlocked } from '@triageai/kernel';
import type { Capabilities, Kernel, MemoryEntry } from '@triageai/kernel';
import { MemoryStore } from '@triageai/kernel';

type Embedder = NonNullable<Capabilities['embedder']>;

export interface MemoryToolDeps {
  embedder?: () => Embedder | undefined;
}

const HitSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.string(),
  scope: z.string(),
  score: z.number(),
  sourceRefs: z.array(z.string()),
  sensitivity: z.string(),
  useCount: z.number(),
});

const CreateInput = z
  .object({
    text: z.string().trim().min(1).max(2000),
    kind: z.enum(['fact', 'preference', 'procedure', 'lesson']),
    sourceRefs: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
    confidence: z.number().min(0).max(1).optional(),
    derivedFromUntrusted: z.boolean().optional(),
  })
  .strict();

const SearchInput = z
  .object({
    query: z.string().trim().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict();

function scopeFor(ctx: { agentId?: string; workspaceId?: string }): {
  scope: 'agent' | 'workspace';
  scopeId: string;
} {
  if (ctx.agentId) return { scope: 'agent', scopeId: ctx.agentId };
  if (ctx.workspaceId) return { scope: 'workspace', scopeId: ctx.workspaceId };
  throw policyBlocked('memory tools need an agent or workspace scope');
}

function hit(entry: MemoryEntry, score: number) {
  return {
    id: entry.id,
    text: entry.text,
    kind: entry.kind,
    scope: entry.scope,
    score: Number(score.toFixed(4)),
    sourceRefs: entry.sourceRefs,
    sensitivity: entry.sensitivity,
    useCount: entry.useCount,
  };
}

async function embed(
  deps: MemoryToolDeps,
  text: string,
): Promise<{ embedding?: number[]; embeddingModel?: string }> {
  const embedder = deps.embedder?.();
  if (!embedder) return {};
  try {
    const result = await embedder.embed([text]);
    const embedding = result.vectors[0];
    return embedding ? { embedding, embeddingModel: result.modelVersion } : {};
  } catch {
    return {};
  }
}

export function registerMemoryTools(kernel: Kernel, deps: MemoryToolDeps = {}): void {
  const store = new MemoryStore(kernel.database);
  if (!kernel.tools.get('memory.search')) {
    kernel.tools.register({
      name: 'memory.search',
      version: '1.0.0',
      owner: 'kernel:memory',
      description: 'Search this agent/workspace long-term memory for relevant sourced facts.',
      examples: [{ query: 'customer refund preference', limit: 5 }],
      input: SearchInput,
      output: z.object({ hits: z.array(HitSchema) }).strict(),
      access: 'read',
      risk: 'low',
      scopes: ['memory:read'],
      egressClass: 'internal',
      idempotent: true,
      timeoutMs: 5_000,
      undo: 'free',
      retry: { maxAttempts: 1, backoff: 'fixed', retryOn: ['timeout'] },
      handler: async (input: z.infer<typeof SearchInput>, ctx) => {
        const scope = scopeFor(ctx);
        const vector = await embed(deps, input.query);
        const hits = await store.recall({
          query: input.query,
          ...scope,
          statuses: ['active'],
          limit: input.limit ?? 5,
          floor: 0.3,
          tokenCeiling: 2_000,
          ...(vector.embedding && vector.embeddingModel
            ? { queryEmbedding: vector.embedding, embeddingModel: vector.embeddingModel }
            : {}),
        });
        return { hits: hits.map((entry) => hit(entry.entry, entry.score)) };
      },
    });
  }
  if (!kernel.tools.get('memory.create')) {
    kernel.tools.register({
      name: 'memory.create',
      version: '1.0.0',
      owner: 'kernel:memory',
      description: 'Propose a sourced long-term memory entry (validated; lessons stay proposed).',
      examples: [
        {
          text: 'Prefers email follow-ups over phone calls.',
          kind: 'preference',
          sourceRefs: ['run:01ABC'],
        },
      ],
      input: CreateInput,
      output: z
        .object({
          id: z.string(),
          text: z.string(),
          kind: z.string(),
          status: z.string(),
          sourceRefs: z.array(z.string()),
        })
        .strict(),
      access: 'write',
      risk: 'low',
      scopes: ['memory:write'],
      egressClass: 'internal',
      idempotent: false,
      timeoutMs: 5_000,
      undo: 'free',
      retry: { maxAttempts: 0, backoff: 'none', retryOn: [] },
      handler: async (input: z.infer<typeof CreateInput>, ctx) => {
        const scope = scopeFor(ctx);
        const vector = await embed(deps, input.text);
        const entry = await store.write({
          ...scope,
          kind: input.kind,
          text: input.text,
          sourceRefs: input.sourceRefs,
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.derivedFromUntrusted !== undefined
            ? { derivedFromUntrusted: input.derivedFromUntrusted }
            : {}),
          ...(vector.embedding && vector.embeddingModel
            ? { embedding: vector.embedding, embeddingModel: vector.embeddingModel }
            : {}),
        });
        return {
          id: entry.id,
          text: entry.text,
          kind: entry.kind,
          status: entry.status,
          sourceRefs: entry.sourceRefs,
        };
      },
    });
  }
}
