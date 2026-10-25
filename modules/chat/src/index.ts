/**
 * chat module (Phase 4): conversations + messages, grounded answers with
 * citations via the `chat.reply` workflow (retrieve → generate → validate →
 * deliver). Retrieval/generation belong to ai-pipeline stages; this module
 * persists its own conversations and applies stage outputs.
 */
import { ulid } from 'ulid';
import { z } from 'zod';

import type { TriageModule } from '@triageai/kernel';

const configSchema = z
  .object({
    collection: z.string().default('kb_docs'),
    retrievalLimit: z.number().int().positive().max(10).default(4),
    maxAnswerTokens: z.number().int().positive().max(2048).default(384),
  })
  .strict();

const MIGRATIONS = [
  {
    id: '0001-chat-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        title TEXT NOT NULL DEFAULT 'Conversation',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        citations JSONB,
        run_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS chat_messages_conversation ON chat_messages (conversation_id, created_at);
    `,
    dropSql: 'DROP TABLE IF EXISTS chat_messages; DROP TABLE IF EXISTS chat_conversations;',
  },
];

interface MessageRow {
  [key: string]: unknown;
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  citations: string[] | null;
  created_at: Date | string;
}

const messageDto = (row: MessageRow) => ({
  id: row.id,
  conversationId: row.conversation_id,
  role: row.role,
  content: row.content,
  citations: row.citations ?? [],
  createdAt: new Date(row.created_at).toISOString(),
});

export const chatModule: TriageModule = {
  id: 'chat',
  version: '0.2.0',
  capabilities: ['queue', 'eventBus'],
  dependsOn: { modules: [{ id: 'ai-pipeline', version: '^0.1.0' }], capabilities: [] },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['chat_conversations', 'chat_messages'],
  manifest: {
    routes: [{ path: '/chat', title: 'Chat' }],
    nav: [{ label: 'Chat', order: 20, path: '/chat' }],
    background: [],
  },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: 'grounded chat with citations' }),
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});

    ctx.registerStageHandler('chat.load', {
      execute: async (stage) => {
        const input = stage.input as { messageId?: string; conversationId?: string };
        if (!input.messageId) throw new Error('chat.load requires messageId');
        const rows = await ctx.database.query<MessageRow>(
          `SELECT id, conversation_id, role, content, citations, created_at
           FROM chat_messages WHERE id = $1`,
          [input.messageId],
        );
        const message = rows[0];
        if (!message) throw new Error(`message ${input.messageId} not found`);
        return {
          output: {
            question: message.content,
            conversationId: message.conversation_id,
            messageId: message.id,
          },
          evidence: { kind: 'deterministic', messageId: message.id },
          deterministic: { messageId: message.id },
        };
      },
    });

    ctx.registerStageHandler('chat.deliver', {
      execute: async (stage) => {
        const input = stage.input as { conversationId?: string; runId?: string };
        if (!input.conversationId) throw new Error('chat.deliver requires conversationId');
        if (input.runId) {
          const existing = await ctx.database.query<{ id: string }>(
            `SELECT id FROM chat_messages WHERE run_id = $1 AND role = 'assistant' LIMIT 1`,
            [input.runId],
          );
          if (existing[0]) {
            return {
              output: { messageId: existing[0].id, deduped: true },
              evidence: { kind: 'deterministic', deduped: true },
              deterministic: { deduped: true },
            };
          }
        }
        const generated = stage.data['generate'] as
          { answer?: string; citations?: string[]; modelVersion?: string } | undefined;
        const validated = stage.data['validate'] as
          { passed?: boolean; checks?: Array<{ checkId: string; passed: boolean }> } | undefined;
        const finalized = stage.data['finalize'] as
          | {
              answer?: string;
              citations?: string[];
              refused?: boolean;
              citationSource?: string;
              grounding?: { coverage?: number; grounded?: boolean };
            }
          | undefined;

        const refusal = 'I could not verify this from the knowledge base.';
        const answer = finalized?.answer?.trim() || refusal;
        const citations = finalized?.refused ? [] : (finalized?.citations ?? []);

        const messageId = ulid();
        await ctx.database.query(
          `INSERT INTO chat_messages (id, conversation_id, role, content, citations, run_id)
           VALUES ($1, $2, 'assistant', $3, $4, $5)`,
          [messageId, input.conversationId, answer, citations, input.runId ?? null],
        );
        await ctx.database.query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [
          input.conversationId,
        ]);
        return {
          output: { messageId, answer, citations, refused: finalized?.refused ?? true },
          evidence: {
            kind: generated ? 'model_generated' : 'deterministic',
            citations,
            citationSource: finalized?.citationSource ?? 'none',
            grounding: finalized?.grounding ?? null,
            validation: validated?.checks ?? null,
          },
          deterministic: {
            citations,
            modelVersion: generated?.modelVersion ?? null,
            refused: finalized?.refused ?? true,
            validationPassed: validated?.passed ?? null,
          },
        };
      },
    });

    ctx.events.subscribe('workflow.run.finished', async (payload) => {
      const event = payload as {
        runId?: string;
        workflowId?: string;
        status?: string;
        input?: { conversationId?: string };
      };
      if (event.workflowId !== 'chat.reply') return;
      if (event.status !== 'FAILED' && event.status !== 'AWAITING') return;
      const conversationId = event.input?.conversationId;
      if (!conversationId) return;
      const existing = await ctx.database.query<{ id: string }>(
        `SELECT id FROM chat_messages WHERE conversation_id = $1 AND run_id = $2 AND role = 'assistant'`,
        [conversationId, event.runId ?? null],
      );
      if (existing[0]) return; // idempotent on re-delivery
      await ctx.database.query(
        `INSERT INTO chat_messages (id, conversation_id, role, content, citations, run_id)
         VALUES ($1, $2, 'assistant', $3, '[]'::jsonb, $4)`,
        [
          ulid(),
          conversationId,
          'I could not verify this from the knowledge base.',
          event.runId ?? null,
        ],
      );
      await ctx.database.query(`UPDATE chat_conversations SET updated_at = now() WHERE id = $1`, [
        conversationId,
      ]);
    });

    ctx.queue.start({
      id: 'chat.reply',
      module: 'chat',
      version: '0.2.0',
      trigger: { type: 'endpoint' },
      fallbackPolicyId: 'return_uncertain',
      stages: [
        {
          id: 'load',
          kind: 'chat.load',
          input: { messageId: '$.messageId', conversationId: '$.conversationId' },
        },
        {
          id: 'retrieve',
          kind: 'ai.retrieve',
          input: {
            query: '${stages.load.output.question}',
            collection: options.collection,
            limit: options.retrievalLimit,
            filter: { approved: true },
          },
        },
        {
          id: 'generate',
          kind: 'ai.generate',
          when: '${stages.retrieve.output.sufficient}',
          input: {
            question: '${stages.load.output.question}',
            chunks: '${stages.retrieve.output.chunks}',
            style: 'assistant',
            maxTokens: options.maxAnswerTokens,
          },
        },
        {
          id: 'validate',
          kind: 'ai.validate',
          when: '${stages.retrieve.output.sufficient}',
          input: {
            answer: '${stages.generate.output.answer}',
            question: '${stages.load.output.question}',
            sources: '${stages.retrieve.output.chunks}',
            policy: { maxChars: 8000 },
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
        {
          id: 'deliver',
          kind: 'chat.deliver',
          input: {
            conversationId: '${stages.load.output.conversationId}',
            runId: '${run.id}',
          },
        },
      ],
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      handler: async (request) => {
        const body = z.object({ title: z.string().max(200).optional() }).parse(request.body ?? {});
        const id = ulid();
        await ctx.database.query(`INSERT INTO chat_conversations (id, title) VALUES ($1, $2)`, [
          id,
          body.title ?? 'Conversation',
        ]);
        return { conversationId: id };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/chat/conversations',
      handler: async () => {
        const rows = await ctx.database.query<Record<string, unknown>>(
          `SELECT id, title, created_at, updated_at FROM chat_conversations ORDER BY updated_at DESC LIMIT 50`,
        );
        return rows.map((row) => ({
          id: row.id,
          title: row.title,
          createdAt: new Date(row.created_at as string).toISOString(),
          updatedAt: new Date(row.updated_at as string).toISOString(),
        }));
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/chat/conversations/:id',
      handler: async (request) => {
        const rows = await ctx.database.query<MessageRow>(
          `SELECT id, conversation_id, role, content, citations, created_at
           FROM chat_messages WHERE conversation_id = $1 ORDER BY created_at`,
          [request.params.id],
        );
        return { conversationId: request.params.id, messages: rows.map(messageDto) };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/chat/messages',
      handler: async (request) => {
        const body = z
          .object({
            conversationId: z.string().optional(),
            text: z.string().min(1).max(20_000),
          })
          .parse(request.body);

        let conversationId = body.conversationId;
        if (!conversationId) {
          conversationId = ulid();
          await ctx.database.query(`INSERT INTO chat_conversations (id, title) VALUES ($1, $2)`, [
            conversationId,
            body.text.slice(0, 80),
          ]);
        }
        const messageId = ulid();
        await ctx.database.query(
          `INSERT INTO chat_messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
          [messageId, conversationId, body.text],
        );
        const started = await ctx.queue.startWorkflow(
          'chat.reply',
          { conversationId, messageId },
          { trigger: 'endpoint' },
        );
        return { conversationId, messageId, runId: started.runId };
      },
    });

    ctx.registerRetentionTask({
      id: 'chat.messages',
      apply: async ({ database, cutoffs }) => {
        if (!cutoffs.messages) return 0;
        const rows = await database.query(
          `DELETE FROM chat_messages WHERE created_at < $1 RETURNING id`,
          [cutoffs.messages],
        );
        return rows.length;
      },
    });
  },
};
