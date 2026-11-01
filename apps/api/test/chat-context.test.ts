import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, ChatModel, Kernel, VectorStore } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { PgRetriever, PgVectorStore, type HttpEmbedder } from '../src/services/capabilities.js';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

const failingModel: ChatModel = {
  describe() {
    return {
      provider: 'test',
      model: 'tiny-window',
      hosted: false,
      contextWindow: 1_200,
      maxOutput: 128,
      supportsTools: false,
      supportsStreaming: false,
    };
  },
  async chat() {
    throw new Error('summariser unavailable');
  },
};

describeIfDb('chat context compaction', () => {
  let app: FastifyInstance & { kernel?: Kernel };
  let database: PostgresDatabase;
  let dir: string;
  let conversationId = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'triageai-context-'));
    const configPath = path.join(dir, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'assistant',
        queue: { adapter: 'pg-queue', pollIntervalMs: 50 },
        modules: {
          chat: { enabled: true, options: { fallbackContextWindow: 1200, maxAnswerTokens: 128 } },
          'ai-pipeline': { enabled: true },
        },
        capabilities: {},
      }),
    );
    database = new PostgresDatabase(DATABASE_URL);
    const vectorStore: VectorStore = new PgVectorStore(database);
    const embedder = {
      embed: async (texts: string[]) => ({
        vectors: texts.map(() => new Array<number>(384).fill(0.1)),
        modelVersion: 'fake',
      }),
    };
    const capabilities: Capabilities = {
      chatModel: failingModel,
      embedder: embedder as unknown as HttpEmbedder,
      vectorStore,
      retriever: new PgRetriever(embedder, vectorStore, 0.1, 0.001),
    };
    app = (await buildApp({
      quiet: true,
      configPath,
      setup: false,
      authMode: 'disabled',
      capabilities,
    })) as FastifyInstance & { kernel?: Kernel };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/conversations',
      payload: { title: 'long conversation' },
    });
    conversationId = (created.json() as { conversationId: string }).conversationId;
    for (let index = 0; index < 30; index += 1) {
      await database.query(
        `INSERT INTO mod_chat.chat_messages (id, conversation_id, role, content)
         VALUES ($1, $2, $3, $4)`,
        [
          `seed-${Date.now()}-${index}`,
          conversationId,
          index % 2 === 0 ? 'user' : 'assistant',
          `Turn ${index}: the refund policy is five business days and we must always cite it. ${'context '.repeat(40)}`,
        ],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await database
      .query(`DELETE FROM mod_chat.chat_messages WHERE conversation_id = $1`, [conversationId])
      .catch(() => undefined);
    await database
      .query(`DELETE FROM mod_chat.chat_conversations WHERE id = $1`, [conversationId])
      .catch(() => undefined);
    await app?.close();
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('compacts before the next call and keeps old messages', async () => {
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/messages',
      payload: { conversationId, text: 'What did we decide about refunds?' },
    });
    expect(sent.statusCode).toBe(200);
    let row:
      | {
          summary: string | null;
          summary_version: number;
          context: Record<string, unknown> | null;
        }
      | undefined;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const rows = await database.query<{
        summary: string | null;
        summary_version: number;
        context: Record<string, unknown> | null;
      }>(
        `SELECT summary, summary_version, context FROM mod_chat.chat_conversations WHERE id = $1`,
        [conversationId],
      );
      row = rows[0];
      if (row?.context) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(row?.summary_version).toBeGreaterThan(0);
    expect(row?.summary).toMatch(/refund|Facts|Decisions/i);
    expect(row?.context).toMatchObject({ compacted: true, degraded: true });
    const count = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM mod_chat.chat_messages WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(count[0]?.count).toBeGreaterThanOrEqual(31);
  }, 60_000);
});
