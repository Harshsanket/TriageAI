import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import { AgentDefinitionSchema, MemoryStore } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { promoteLesson } from '../src/services/agents.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

const definition = AgentDefinitionSchema.parse({
  id: 'test-memory-agent',
  displayName: 'Memory Agent',
  version: 1,
  profile: 'Answer with the remembered preferences.',
  job: {
    role: 'remember preferences',
    inputs: 'a goal',
    output: 'an answer',
    doneWhen: 'the answer uses a memory',
    domain: 'test',
  },
  agentReason: ['own_schedule'],
  tools: [],
  scopes: [],
  maxSteps: 2,
  egressClass: 'internal',
});

let app: App;

beforeEach(async () => {
  app = (await buildApp({
    quiet: true,
    configPath: resolve(process.cwd(), '../../triage.config.json'),
  })) as App;
  await app.kernel!.database.query(
    `INSERT INTO agent_definitions (id, display_name, version, definition)
    VALUES ($1, $2, 1, $3)
    ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition, version = 1`,
    [definition.id, definition.displayName, definition],
  );
});

afterEach(async () => {
  const db = app.kernel?.database;
  if (db) {
    await db.query(`DELETE FROM memories WHERE scope_id = ANY($1::text[])`, [
      [definition.id, 'test-memory-user'],
    ]);
    await db.query(`DELETE FROM user_skills WHERE name LIKE 'lesson-%'`);
    await db.query(`DELETE FROM agent_definitions WHERE id = $1`, [definition.id]);
    await db.query(`DELETE FROM audit_events WHERE action = 'memory.promoted'`);
  }
  await app.close();
});

describeIfDb('/agents memory viewer and lesson promotion (phase 16.T5/T9)', () => {
  it('returns agent memories and a deterministic memory.md on the existing detail route', async () => {
    const store = new MemoryStore(app.kernel!.database);
    const preference = await store.write({
      scope: 'agent',
      scopeId: definition.id,
      kind: 'preference',
      text: 'The user prefers concise answers',
      sourceRefs: ['ticket:1'],
    });
    const fact = await store.write({
      scope: 'agent',
      scopeId: definition.id,
      kind: 'fact',
      text: 'Refunds take five days.',
      sourceRefs: ['ticket:2'],
    });
    const lesson = await store.write({
      scope: 'agent',
      scopeId: definition.id,
      kind: 'lesson',
      text: 'After any layout change, check that no interactive element is covered.',
      sourceRefs: ['ticket:3'],
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${definition.id}`,
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      memory: { entries: Array<{ id: string; status: string }>; markdown: string };
    };
    expect(body.memory.entries.map((entry) => entry.id).sort()).toEqual(
      [preference.id, fact.id, lesson.id].sort(),
    );
    expect(body.memory.markdown).toContain('The user prefers concise answers');
    expect(body.memory.markdown).toContain('Refunds take five days.');
    expect(body.memory.markdown).not.toContain('no interactive element is covered');

    const searched = await app.inject({
      method: 'GET',
      url: `/api/v1/agents/${definition.id}?memoryQuery=refund`,
    });
    expect(searched.statusCode).toBe(200);
    const searchedBody = searched.json() as { memory: { entries: Array<{ id: string }> } };
    expect(searchedBody.memory.entries.map((entry) => entry.id)).toEqual([fact.id]);
  });

  it('promotes a reviewed lesson to a skill and archives it idempotently', async () => {
    const store = new MemoryStore(app.kernel!.database);
    const lesson = await store.write({
      scope: 'agent',
      scopeId: definition.id,
      kind: 'lesson',
      text: 'After any layout change, check that no interactive element is covered.',
      sourceRefs: ['ticket:promote-skill'],
    });
    await store.review(lesson.id, 'active');

    const promoted = await promoteLesson(app.kernel!, {
      memoryId: lesson.id,
      target: 'skill',
      actor: 'test',
    });
    expect(promoted).toMatchObject({ promoted: true, archived: true });
    expect(promoted.ref).toMatch(/^promoted:skill:lesson-/);
    const skills = await app.kernel!.database.query<{
      name: string;
      content: string;
      version: number;
      scope: string;
    }>(`SELECT name, content, version, scope FROM user_skills WHERE name LIKE 'lesson-%'`);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.content).toContain('no interactive element is covered');
    expect(skills[0]).toMatchObject({ version: 1, scope: 'instance' });

    const memory = await app.kernel!.database.query<{
      status: string;
      source_refs: string[];
    }>(`SELECT status, source_refs FROM memories WHERE id = $1`, [lesson.id]);
    expect(memory[0]?.status).toBe('archived');
    expect(memory[0]?.source_refs).toContain(promoted.ref);

    const again = await promoteLesson(app.kernel!, {
      memoryId: lesson.id,
      target: 'skill',
      actor: 'test',
    });
    expect(again).toMatchObject({ promoted: false, ref: promoted.ref });
    const versions = await app.kernel!.database.query<{ version: number }>(
      `SELECT version FROM user_skills WHERE name LIKE 'lesson-%'`,
    );
    expect(versions[0]?.version).toBe(1);
  });

  it('promotes a reviewed lesson into the agent profile and refuses unreviewed lessons', async () => {
    const store = new MemoryStore(app.kernel!.database);
    const lesson = await store.write({
      scope: 'agent',
      scopeId: definition.id,
      kind: 'lesson',
      text: 'Always verify the tool permission before enabling an integration.',
      sourceRefs: ['ticket:promote-profile'],
    });
    await expect(
      promoteLesson(app.kernel!, { memoryId: lesson.id, target: 'profile', actor: 'test' }),
    ).rejects.toThrow(/reviewed/);
    await store.review(lesson.id, 'active');
    const promoted = await promoteLesson(app.kernel!, {
      memoryId: lesson.id,
      target: 'profile',
      actor: 'test',
    });
    expect(promoted.ref).toBe(`promoted:profile:${definition.id}`);
    const rows = await app.kernel!.database.query<{
      definition: { profile: string; version: number };
      version: number;
    }>(`SELECT definition, version FROM agent_definitions WHERE id = $1`, [definition.id]);
    expect(rows[0]?.definition.profile).toContain(
      'Rule: Always verify the tool permission before enabling an integration.',
    );
    expect(rows[0]?.version).toBe(2);
    expect(rows[0]?.definition.version).toBe(2);
  });
});
