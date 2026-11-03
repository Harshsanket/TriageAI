/**
 * public-api (Phase 13.T1): scoped, hashed API keys and an OpenAI-compatible
 * surface backed by the grounded `public_api.completion` workflow.
 */
import { createHash, randomBytes } from 'node:crypto';

import { ulid } from 'ulid';
import { z } from 'zod';

import { AppError, invalid, notFound, rateLimited } from '@triageai/kernel';
import type { TriageModule } from '@triageai/kernel';

const configSchema = z
  .object({
    collection: z.string().default('kb_docs'),
    retrievalLimit: z.number().int().positive().max(10).default(4),
    rateLimitPerMinute: z.number().int().positive().default(60),
  })
  .strict();

const MIGRATIONS = [
  {
    id: '0002-external-agents',
    sql: `
      CREATE TABLE IF NOT EXISTS public_external_agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public_external_handoffs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        from_agent_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        handoff JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        fetched_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS public_external_steps (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        run_id TEXT,
        step TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS public_external_handoffs_agent
        ON public_external_handoffs (agent_id, fetched_at);
    `,
    dropSql:
      'DROP TABLE IF EXISTS public_external_steps; DROP TABLE IF EXISTS public_external_handoffs; DROP TABLE IF EXISTS public_external_agents;',
  },
  {
    id: '0001-api-keys',
    sql: `
      CREATE TABLE IF NOT EXISTS public_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT[] NOT NULL DEFAULT '{}',
        rate_limit_per_minute INT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS public_api_keys_hash ON public_api_keys (key_hash);
    `,
    dropSql: 'DROP TABLE IF EXISTS public_api_keys;',
  },
];

const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Scopes a public API key may hold. External-agent keys are a separate class. */
const KEY_SCOPES = ['chat', 'embeddings', 'kb'] as const;
type KeyScope = (typeof KEY_SCOPES)[number];

function requireScope(key: ApiKey, scope: KeyScope): void {
  if (key.scopes.includes(scope)) return;
  throw new AppError(
    'public_api.SCOPE_FORBIDDEN',
    `the API key is missing the "${scope}" scope`,
    { requiredScope: scope, scopes: key.scopes },
    403,
    { category: 'forbidden', retryable: false },
  );
}

interface KeyRow {
  [key: string]: unknown;
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rate_limit_per_minute: number | null;
  revoked_at: string | null;
}

interface ApiKey {
  id: string;
  name: string;
  scopes: string[];
  rateLimitPerMinute: number;
}

const CompletionBody = z
  .object({
    model: z.string().optional(),
    messages: z
      .array(
        z.object({
          role: z.enum(['system', 'user', 'assistant']),
          content: z.string(),
        }),
      )
      .min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().max(4096).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .passthrough();

const EmbeddingBody = z
  .object({ model: z.string().optional(), input: z.union([z.string(), z.array(z.string())]) })
  .passthrough();

export const publicApiModule: TriageModule = {
  id: 'public-api',
  version: '0.1.0',
  capabilities: ['queue', 'eventBus'],
  permissions: {
    storage: { schema: true },
    routes: [
      { method: 'GET', path: '/api/v1/public-api/external-agents' },
      { method: 'GET', path: '/api/v1/public-api/keys' },
      { method: 'GET', path: '/v1/external-agents/handoffs' },
      { method: 'GET', path: '/v1/a2a/tasks/:id' },
      { method: 'POST', path: '/api/v1/public-api/external-agents' },
      { method: 'POST', path: '/api/v1/public-api/external-agents/:id/handoffs' },
      { method: 'POST', path: '/api/v1/public-api/kb/search' },
      { method: 'POST', path: '/api/v1/public-api/keys' },
      { method: 'POST', path: '/api/v1/public-api/keys/:id/revoke' },
      { method: 'POST', path: '/v1/chat/completions' },
      { method: 'POST', path: '/v1/embeddings' },
      { method: 'POST', path: '/v1/external-agents/steps' },
      { method: 'POST', path: '/v1/a2a/tasks' },
    ],
    events: { publish: [], subscribe: [] },
    capabilities: {
      consume: ['queue', 'eventBus', 'retriever', 'generator', 'embedder', 'validator'],
      provide: [],
    },
    stages: [],
    workflows: ['public_api.completion'],
    evals: [],
    tools: [],
    knowledge: { read: ['*'], write: [] },
  },
  dependsOn: {
    capabilities: [
      { capability: 'retriever', optional: true },
      { capability: 'generator', optional: true },
      { capability: 'embedder', optional: true },
      { capability: 'validator', optional: true },
    ],
  },
  configSchema,
  migrations: MIGRATIONS,
  tables: [
    'public_api_keys',
    'public_external_agents',
    'public_external_handoffs',
    'public_external_steps',
  ],
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: 'scoped public API' }),
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const windows = new Map<string, { startedAt: number; count: number }>();

    const authenticate = async (request: { headers?: Record<string, string> }): Promise<ApiKey> => {
      const header = request.headers?.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token) {
        throw new AppError('public_api.KEY_REQUIRED', 'an API key is required', undefined, 401, {
          category: 'unauthenticated',
          retryable: false,
        });
      }
      const rows = await ctx.database.query<KeyRow>(
        `SELECT id, name, prefix, scopes, rate_limit_per_minute, revoked_at
         FROM public_api_keys WHERE key_hash = $1`,
        [hashKey(token)],
      );
      const row = rows[0];
      if (!row || row.revoked_at) {
        throw new AppError(
          'public_api.KEY_INVALID',
          'the API key is invalid or revoked',
          undefined,
          401,
          {
            category: 'unauthenticated',
            retryable: false,
          },
        );
      }
      const limit = row.rate_limit_per_minute ?? options.rateLimitPerMinute;
      const now = Date.now();
      const window = windows.get(row.id);
      if (!window || now - window.startedAt > 60_000) {
        windows.set(row.id, { startedAt: now, count: 1 });
      } else {
        window.count += 1;
        if (window.count > limit) throw rateLimited(60_000, 'API key rate limit exceeded');
      }
      await ctx.database.query(`UPDATE public_api_keys SET last_used_at = now() WHERE id = $1`, [
        row.id,
      ]);
      return {
        id: row.id,
        name: row.name,
        scopes: row.scopes ?? [],
        rateLimitPerMinute: limit,
      };
    };

    const authenticateExternal = async (request: {
      headers?: Record<string, string>;
    }): Promise<{ id: string; name: string }> => {
      const header = request.headers?.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token) {
        throw new AppError('public_api.KEY_REQUIRED', 'an API key is required', undefined, 401, {
          category: 'unauthenticated',
          retryable: false,
        });
      }
      const rows = await ctx.database.query<{ id: string; name: string; enabled: boolean }>(
        `SELECT id, name, enabled FROM public_external_agents WHERE key_hash = $1`,
        [hashKey(token)],
      );
      if (!rows[0] || !rows[0].enabled) {
        throw new AppError(
          'public_api.KEY_INVALID',
          'the API key is invalid or revoked',
          undefined,
          401,
          {
            category: 'unauthenticated',
            retryable: false,
          },
        );
      }
      return { id: rows[0].id, name: rows[0].name };
    };

    const waitForRun = async (runId: string, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = await ctx.runs.get(runId);
        if (!found) throw notFound(`run ${runId} not found`);
        const run = found.run;
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING'].includes(run.status)) {
          return { status: run.status, error: run.error };
        }
        if (Date.now() > deadline)
          throw new AppError('public_api.TIMEOUT', 'the run timed out', undefined, 504, {
            category: 'timeout',
            retryable: true,
          });
        await new Promise((resolveTick) => setTimeout(resolveTick, 150));
      }
    };

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/public-api/keys',
      handler: async (request) => {
        const body = z
          .object({
            name: z.string().min(1).max(80),
            scopes: z
              .array(z.enum(KEY_SCOPES))
              .min(1)
              .default([...KEY_SCOPES]),
            rateLimitPerMinute: z.number().int().positive().optional(),
          })
          .strict()
          .parse(request.body ?? {});
        const token = `tk_${randomBytes(32).toString('base64url')}`;
        const id = ulid();
        await ctx.database.query(
          `INSERT INTO public_api_keys
             (id, name, prefix, key_hash, scopes, rate_limit_per_minute, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            body.name,
            token.slice(0, 10),
            hashKey(token),
            body.scopes,
            body.rateLimitPerMinute ?? null,
            request.actor ?? null,
          ],
        );
        return { id, key: token, prefix: token.slice(0, 10), scopes: body.scopes };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/public-api/keys',
      handler: async () => {
        const rows = await ctx.database.query<KeyRow>(
          `SELECT id, name, prefix, scopes, rate_limit_per_minute, revoked_at
           FROM public_api_keys ORDER BY created_at DESC`,
        );
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          prefix: row.prefix,
          scopes: row.scopes,
          rateLimitPerMinute: row.rate_limit_per_minute,
          revokedAt: row.revoked_at,
        }));
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/public-api/keys/:id/revoke',
      handler: async (request) => {
        const rows = await ctx.database.query<{ id: string }>(
          `UPDATE public_api_keys SET revoked_at = now()
           WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
          [request.params.id],
        );
        if (!rows[0]) throw notFound(`key ${request.params.id} not found`);
        return { id: rows[0].id, revoked: true };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/public-api/external-agents',
      handler: async (request) => {
        const body = z
          .object({ name: z.string().min(1).max(80) })
          .strict()
          .parse(request.body ?? {});
        const id = ulid();
        const token = `ta_${randomBytes(32).toString('base64url')}`;
        await ctx.database.query(
          `INSERT INTO public_external_agents (id, name, key_hash) VALUES ($1, $2, $3)`,
          [id, body.name, hashKey(token)],
        );
        return { id, name: body.name, key: token };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/public-api/external-agents',
      handler: async () => {
        const rows = await ctx.database.query<{
          id: string;
          name: string;
          enabled: boolean;
          created_at: string;
        }>(
          `SELECT id, name, enabled, created_at FROM public_external_agents ORDER BY created_at DESC`,
        );
        return rows.map((row) => ({
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          createdAt: new Date(row.created_at).toISOString(),
        }));
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/public-api/external-agents/:id/handoffs',
      handler: async (request) => {
        const body = z
          .object({
            fromAgentId: z.string().min(1),
            goal: z.string().min(1).max(500),
            handoff: z.record(z.string(), z.unknown()).prefault({}),
          })
          .strict()
          .parse(request.body ?? {});
        const id = ulid();
        await ctx.database.query(
          `INSERT INTO public_external_handoffs (id, agent_id, from_agent_id, goal, handoff)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, request.params.id, body.fromAgentId, body.goal, body.handoff],
        );
        return { id, agentId: request.params.id, goal: body.goal, status: 'pending' };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/v1/external-agents/handoffs',
      handler: async (request) => {
        const agent = await authenticateExternal(request);
        const rows = await ctx.database.query<Record<string, unknown>>(
          `SELECT id, from_agent_id, goal, handoff, created_at FROM public_external_handoffs
           WHERE agent_id = $1 AND fetched_at IS NULL ORDER BY created_at`,
          [agent.id],
        );
        for (const row of rows) {
          await ctx.database.query(
            `UPDATE public_external_handoffs SET fetched_at = now() WHERE id = $1`,
            [row.id],
          );
        }
        return rows.map((row) => ({
          id: row.id,
          fromAgentId: row.from_agent_id,
          goal: row.goal,
          handoff: row.handoff,
          createdAt: row.created_at,
        }));
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/v1/external-agents/steps',
      handler: async (request) => {
        const agent = await authenticateExternal(request);
        const body = z
          .object({
            runId: z.string().optional(),
            step: z.string().min(1).max(200),
            payload: z.record(z.string(), z.unknown()).prefault({}),
          })
          .strict()
          .parse(request.body ?? {});
        const id = ulid();
        await ctx.database.query(
          `INSERT INTO public_external_steps (id, agent_id, run_id, step, payload)
           VALUES ($1, $2, $3, $4, $5)`,
          [id, agent.id, body.runId ?? null, body.step, body.payload],
        );
        return { id, agentId: agent.id, accepted: true };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/v1/chat/completions',
      handler: async (request) => {
        const key = await authenticate(request);
        requireScope(key, 'chat');
        const body = CompletionBody.parse(request.body ?? {});
        const question = [...body.messages]
          .reverse()
          .find((message) => message.role === 'user')?.content;
        if (!question) throw invalid('at least one user message is required');
        if (body.stream) {
          throw new AppError(
            'public_api.STREAM_UNSUPPORTED',
            'streaming is not supported on this endpoint yet; use stream:false',
            undefined,
            400,
          );
        }

        const started = await ctx.queue.startWorkflow(
          'public_api.completion',
          { question, collection: options.collection, limit: options.retrievalLimit },
          { trigger: 'endpoint' },
        );
        const run = await waitForRun(started.runId);
        const found = await ctx.runs.get(started.runId);
        const stages = (found?.stages ?? []).filter((stage) => stage.status === 'SUCCEEDED');
        const byId = new Map(
          stages.map((stage) => [stage.stageId, stage.output as Record<string, unknown>]),
        );
        const finalized = byId.get('finalize');
        const generated = byId.get('generate');
        const answer =
          (finalized?.answer as string | undefined) ??
          (run.error
            ? 'The answer could not be produced right now.'
            : 'I could not verify this from the knowledge base.');
        const citations = (finalized?.citations as string[] | undefined) ?? [];
        return {
          id: `chatcmpl_${started.runId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? (generated?.modelVersion as string | undefined) ?? 'triageai',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: answer },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          x_triageai: { runId: started.runId, citations, refused: citations.length === 0 },
        };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/v1/embeddings',
      handler: async (request) => {
        const key = await authenticate(request);
        requireScope(key, 'embeddings');
        const body = EmbeddingBody.parse(request.body ?? {});
        const embedder = ctx.capabilities.embedder;
        if (!embedder) {
          throw new AppError(
            'public_api.UNAVAILABLE',
            'the embedding model is not configured',
            undefined,
            503,
            { category: 'dependency_unavailable', retryable: true },
          );
        }
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        const result = await embedder.embed(inputs);
        return {
          object: 'list',
          model: body.model ?? result.modelVersion,
          data: result.vectors.map((embedding, index) => ({
            object: 'embedding',
            index,
            embedding,
          })),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/public-api/kb/search',
      handler: async (request) => {
        const key = await authenticate(request);
        requireScope(key, 'kb');
        const body = z
          .object({
            query: z.string().min(1),
            limit: z.number().int().positive().max(20).optional(),
          })
          .strict()
          .parse(request.body ?? {});
        const retriever = ctx.capabilities.retriever;
        if (!retriever) {
          throw new AppError(
            'public_api.UNAVAILABLE',
            'the knowledge base is not configured',
            undefined,
            503,
            { category: 'dependency_unavailable', retryable: true },
          );
        }
        const result = await retriever.search(options.collection, body.query, {
          limit: body.limit ?? options.retrievalLimit,
          filter: { sourceEnabled: true },
          audience: 'public',
        });
        return {
          chunks: result.chunks.map((chunk) => ({
            id: chunk.id,
            text: chunk.text,
            score: chunk.score,
            title: (chunk.metadata.title as string | undefined) ?? null,
          })),
          gate: result.gate,
        };
      },
    });

    /** Every external agent owns exactly one A2A workspace namespace. */
    const a2aWorkspace = (agentId: string): string => `a2a:${agentId}`;

    ctx.registerRoute({
      method: 'POST',
      url: '/v1/a2a/tasks',
      handler: async (request) => {
        const agent = await authenticateExternal(request);
        const body = z
          .object({
            workspaceId: z.string().min(1).max(64).optional(),
            title: z.string().min(1).max(200),
            doneWhen: z.string().min(1).max(500),
            inputRefs: z.array(z.string().max(200)).max(50).default([]),
          })
          .strict()
          .parse(request.body ?? {});
        // F4: a task is always bound to the calling agent; a supplied foreign
        // workspace id is refused rather than letting a key inject work into
        // another team's board.
        const ownWorkspace = a2aWorkspace(agent.id);
        if (body.workspaceId !== undefined && body.workspaceId !== ownWorkspace) {
          throw new AppError(
            'public_api.WORKSPACE_FORBIDDEN',
            'the workspace does not belong to this external agent',
            { workspaceId: ownWorkspace },
            403,
            { category: 'forbidden', retryable: false },
          );
        }
        return ctx.tasks.create({
          workspaceId: ownWorkspace,
          rootRunId: ownWorkspace,
          title: body.title,
          doneWhen: body.doneWhen,
          inputRefs: body.inputRefs,
        });
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/v1/a2a/tasks/:id',
      handler: async (request) => {
        const agent = await authenticateExternal(request);
        const task = (await ctx.tasks.get(request.params.id ?? '')) as {
          rootRunId?: string;
        } | null;
        // Cross-agent and internal tasks are indistinguishable from missing.
        if (!task || task.rootRunId !== a2aWorkspace(agent.id)) throw notFound('task not found');
        return task;
      },
    });

    ctx.queue.start({
      id: 'public_api.completion',
      module: 'public-api',
      version: '0.1.0',
      trigger: { type: 'endpoint' },
      fallbackPolicyId: 'return_uncertain',
      stages: [
        {
          id: 'retrieve',
          kind: 'ai.retrieve',
          input: {
            query: '$.question',
            collection: '$.collection',
            limit: '$.limit',
            filter: { sourceEnabled: true },
            audience: 'public',
          },
        },
        {
          id: 'generate',
          kind: 'ai.generate',
          when: '${stages.retrieve.output.sufficient}',
          input: {
            question: '$.question',
            chunks: '${stages.retrieve.output.chunks}',
            style: 'assistant',
          },
        },
        {
          id: 'validate',
          kind: 'ai.validate',
          when: '${stages.retrieve.output.sufficient}',
          input: {
            answer: '${stages.generate.output.answer}',
            question: '$.question',
            sources: '${stages.retrieve.output.chunks}',
            policy: { maxChars: 4000 },
          },
        },
        {
          id: 'finalize',
          kind: 'ai.finalize_answer',
          when: '${stages.validate.output.passed}',
          input: {
            answer: '${stages.generate.output.answer}',
            sources: '${stages.retrieve.output.chunks}',
          },
        },
      ],
    });
  },
};
