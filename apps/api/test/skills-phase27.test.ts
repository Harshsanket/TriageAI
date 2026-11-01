import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, Kernel, VectorStore } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { PgRetriever, PgVectorStore, type HttpEmbedder } from '../src/services/capabilities.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const COLLECTION = `skills_${Date.now()}`;

const embedder = {
  embed: async (texts: string[]) => ({
    vectors: texts.map(() => new Array<number>(384).fill(0.1)),
    modelVersion: 'fake',
  }),
};

describeIfDb('user skills and chat capture', () => {
  let app: FastifyInstance & { kernel?: Kernel };
  let database: PostgresDatabase;
  let dir: string;
  const skillIds: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'triageai-skills-'));
    const configPath = path.join(dir, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'assistant',
        queue: { adapter: 'pg-queue', pollIntervalMs: 50 },
        modules: {
          kb: { enabled: true, options: { collection: COLLECTION } },
          chat: { enabled: true, options: { collection: COLLECTION } },
        },
        capabilities: {
          embedder: { adapter: 'test' },
          vectorStore: { adapter: 'test' },
          retriever: { adapter: 'test' },
        },
      }),
    );
    database = new PostgresDatabase(DATABASE_URL);
    const vectorStore: VectorStore = new PgVectorStore(database);
    const capabilities: Capabilities = {
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
  }, 60_000);

  afterAll(async () => {
    await database.query(`DELETE FROM user_skills`).catch(() => undefined);
    await database.query(`DELETE FROM chat_messages`).catch(() => undefined);
    await database.query(`DELETE FROM mod_chat.chat_messages`).catch(() => undefined);
    await database.query(`DELETE FROM mod_chat.chat_conversations`).catch(() => undefined);
    await database.query(`DELETE FROM mod_kb.kb_ingest_items`).catch(() => undefined);
    await database
      .query(`DELETE FROM mod_kb.kb_sources WHERE managed_key LIKE 'skill:%'`)
      .catch(() => undefined);
    await database.query(`DELETE FROM vector_chunks WHERE collection = $1`, [COLLECTION]);
    await app?.close();
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates, lists, toggles and deletes a custom skill', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      payload: {
        name: 'cite-policy',
        description: 'Cite the policy name in compliance answers.',
        instructions: 'Always cite the policy name when answering compliance questions.',
      },
    });
    expect(created.statusCode).toBe(200);
    const skill = (
      created.json() as { skill: { id: string; enabled: boolean; provenance: string } }
    ).skill;
    skillIds.push(skill.id);
    expect(skill.enabled).toBe(true);
    expect(skill.provenance).toBe('custom');

    const listed = await app.inject({ method: 'GET', url: '/api/v1/skills' });
    expect(listed.json()).toMatchObject({
      skills: [expect.objectContaining({ name: 'cite-policy', enabled: true })],
    });

    const off = await app.inject({
      method: 'PATCH',
      url: `/api/v1/skills/${skill.id}`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { skill: { enabled: boolean } }).skill.enabled).toBe(false);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/skills/${skill.id}`,
    });
    expect(removed.statusCode).toBe(200);
  });

  it('lists the default GitHub sources with import state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/skills/sources' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      sources: Array<{ name: string; repo: string; status: string }>;
    };
    expect(body.sources.map((source) => source.repo)).toEqual(
      expect.arrayContaining(['Harshsanket/docs-internal', 'poteto/noodles']),
    );
    expect(
      body.sources.every((source) => ['imported', 'not_imported'].includes(source.status)),
    ).toBe(true);
  });

  it('captures an explicit chat preference and shows a notice', async () => {
    const before = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM user_skills WHERE provenance = 'chat'`,
    );
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/messages',
      payload: { text: 'From now on, always cite the policy name.' },
    });
    expect(sent.statusCode).toBe(200);
    const conversationId = (sent.json() as { conversationId: string }).conversationId;
    const rows = await database.query<{ name: string; enabled: boolean; suggestion: boolean }>(
      `SELECT name, enabled, suggestion FROM user_skills WHERE provenance = 'chat'`,
    );
    expect(rows.length).toBeGreaterThan(before[0]?.count ?? 0);
    expect(rows.some((row) => row.enabled && !row.suggestion)).toBe(true);
    const messages = await database.query<{ content: string }>(
      `SELECT content FROM mod_chat.chat_messages WHERE conversation_id = $1 AND role = 'assistant'`,
      [conversationId],
    );
    expect(messages.some((message) => /Added skill:/.test(message.content))).toBe(true);
  }, 30_000);

  it('saves inferred preferences as suggestions and accepts them', async () => {
    const id = `suggestion-${Date.now()}`;
    await database.query(
      `INSERT INTO user_skills
         (id, owner_id, scope, name, description, content, enabled, provenance, suggestion)
       VALUES ($1, NULL, 'user', $2, $3, $4, false, 'suggestion', true)`,
      [id, `suggest-${Date.now()}`, 'Prefer short bullet answers.', '# short'],
    );
    const list = await app.inject({ method: 'GET', url: '/api/v1/skills' });
    const suggestions = (list.json() as { suggestions: Array<{ id: string }> }).suggestions;
    expect(suggestions.some((entry) => entry.id === id)).toBe(true);

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/skills/${id}/suggestion`,
      payload: { action: 'accept' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(
      (accepted.json() as { skill: { enabled: boolean; suggestion: boolean } }).skill,
    ).toMatchObject({
      enabled: true,
      suggestion: false,
    });
    await database.query(`DELETE FROM user_skills WHERE id = $1`, [id]);
  });

  it('mirrors enabled skills into managed operator KB sources', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/skills',
      payload: {
        name: `mirror-${Date.now()}`,
        description: 'A skill that should be mirrored into the knowledge base.',
        instructions: 'Answer with a short summary first.',
      },
    });
    const skill = (created.json() as { skill: { id: string; name: string } }).skill;
    skillIds.push(skill.id);
    const sources = await app.inject({ method: 'GET', url: '/api/v1/kb/sources' });
    const managed = (
      sources.json() as {
        sources: Array<{ managedKey: string | null; readOnly: boolean; audience: string }>;
      }
    ).sources.filter((source) => source.managedKey?.startsWith('skill:'));
    expect(managed.some((source) => source.managedKey?.includes(skill.name))).toBe(true);
    expect(managed.every((source) => source.readOnly && source.audience === 'operator')).toBe(true);

    await app.inject({ method: 'DELETE', url: `/api/v1/skills/${skill.id}` });
    const after = await app.inject({ method: 'GET', url: '/api/v1/kb/sources' });
    const remaining = (
      after.json() as { sources: Array<{ managedKey: string | null }> }
    ).sources.filter((source) => source.managedKey?.includes(skill.name));
    expect(remaining).toHaveLength(0);
  }, 30_000);
});
