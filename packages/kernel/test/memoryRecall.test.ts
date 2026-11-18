import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryStore, memoryMarkdown, recallMemories } from '../src/memory/index.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type { KernelLogger } from '../src/types.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const PREFIX = 'test-mem-';

let database: PostgresDatabase;

beforeAll(async () => {
  database = new PostgresDatabase(DATABASE_URL);
  await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
  await database.query(`DELETE FROM memories WHERE scope_id LIKE $1`, [`${PREFIX}%`]);
});

afterAll(async () => {
  await database.query(`DELETE FROM memories WHERE scope_id LIKE $1`, [`${PREFIX}%`]);
  await database.close();
});

describeIfDb('memory recall, consolidation and memory.md (phase 16.T5)', () => {
  it('recalls by scope/agent/workspace with a relevance floor and token ceiling', async () => {
    const store = new MemoryStore(database);
    const concise = await store.write({
      scope: 'workspace',
      scopeId: `${PREFIX}ws`,
      kind: 'preference',
      text: 'The user prefers concise answers',
      sourceRefs: ['ticket:1'],
    });
    await store.write({
      scope: 'workspace',
      scopeId: `${PREFIX}ws`,
      kind: 'fact',
      text: 'Refunds take five days.',
      sourceRefs: ['ticket:2'],
    });
    await store.write({
      scope: 'agent',
      scopeId: `${PREFIX}agent`,
      kind: 'fact',
      text: 'Deploys happen on Fridays',
      sourceRefs: ['run:1'],
    });
    await store.write({
      scope: 'agent',
      scopeId: `${PREFIX}other`,
      kind: 'preference',
      text: 'The user prefers detailed answers',
      sourceRefs: ['ticket:3'],
    });

    const hits = await recallMemories(database, {
      query: 'What does the user prefer?',
      agentId: `${PREFIX}agent`,
      workspaceId: `${PREFIX}ws`,
      floor: 0.75,
      tokenCeiling: 1000,
    });
    expect(hits.map((hit) => hit.entry.id)).toEqual([concise.id]);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(0.75);
    const used = await store.list({ scope: 'workspace', scopeId: `${PREFIX}ws` });
    expect(used.find((entry) => entry.id === concise.id)?.useCount).toBe(1);

    const other = await recallMemories(database, {
      query: 'preferred answer style',
      scope: 'agent',
      scopeId: `${PREFIX}other`,
      floor: 0.4,
    });
    expect(other.map((hit) => hit.entry.id)).toEqual([expect.any(String)]);
    expect(other[0]?.entry.scopeId).toBe(`${PREFIX}other`);

    const belowFloor = await recallMemories(database, {
      query: 'refund timing',
      workspaceId: `${PREFIX}ws`,
      floor: 0.75,
      touch: false,
    });
    expect(belowFloor).toEqual([]);
    const relaxed = await recallMemories(database, {
      query: 'refund timing',
      workspaceId: `${PREFIX}ws`,
      floor: 0.4,
      touch: false,
    });
    expect(relaxed[0]?.entry.text).toBe('Refunds take five days.');
  });

  it('stops at the memory token ceiling instead of truncating an entry', async () => {
    const store = new MemoryStore(database);
    const scopeId = `${PREFIX}ceiling`;
    const short = await store.write({
      scope: 'workspace',
      scopeId,
      kind: 'preference',
      text: 'Refund policy: five days.',
      sourceRefs: ['ticket:short'],
    });
    await store.write({
      scope: 'workspace',
      scopeId,
      kind: 'fact',
      text: `Refunds ${'detail '.repeat(40)}`,
      sourceRefs: ['ticket:long'],
    });
    const hits = await recallMemories(database, {
      query: 'refund',
      workspaceId: scopeId,
      floor: 0,
      tokenCeiling: 20,
      touch: false,
    });
    expect(hits.map((hit) => hit.entry.id)).toEqual([short.id]);
  });

  it('exports a deterministic memory.md with only active, masked entries', async () => {
    const store = new MemoryStore(database);
    const scopeId = `${PREFIX}markdown`;
    await store.write({
      scope: 'workspace',
      scopeId,
      kind: 'preference',
      text: 'Email jane@example.com prefers concise answers',
      sourceRefs: ['ticket:md-1'],
    });
    await store.write({
      scope: 'workspace',
      scopeId,
      kind: 'lesson',
      text: 'After any layout change, check that no interactive element is covered.',
      sourceRefs: ['ticket:md-2'],
    });
    const markdown = await store.exportMarkdown('workspace', scopeId);
    expect(markdown).toContain('# Memory');
    expect(markdown).toContain('j***@example.com');
    expect(markdown).not.toContain('jane@example.com');
    expect(markdown).not.toContain('no interactive element is covered');
    expect(await store.exportMarkdown('workspace', scopeId)).toBe(markdown);
    expect(memoryMarkdown([])).toBe('# Memory\n\n_No active memories._\n');
  });

  it('consolidates near-duplicates inside one scope and never across scopes', async () => {
    const store = new MemoryStore(database);
    const scopeId = `${PREFIX}consolidate`;
    const first = await store.write({
      scope: 'workspace',
      scopeId,
      kind: 'fact',
      text: 'Refunds take five days.',
      sourceRefs: ['ticket:a'],
    });
    const second = await store.write({
      scope: 'workspace',
      scopeId,
      kind: 'fact',
      text: 'Refunds take five business days.',
      sourceRefs: ['ticket:b'],
    });
    const otherScope = await store.write({
      scope: 'agent',
      scopeId: `${PREFIX}agent-consolidate`,
      kind: 'fact',
      text: 'Refunds take five business days.',
      sourceRefs: ['ticket:c'],
    });
    const otherKind = await store.write({
      scope: 'workspace',
      scopeId,
      kind: 'preference',
      text: 'Refunds take five business days.',
      sourceRefs: ['ticket:d'],
    });
    const result = await store.consolidate({ workspaceId: scopeId, threshold: 0.8 });
    expect(result.merged).toBe(1);
    expect(result.archivedIds).toEqual([second.id]);
    expect(result.keptIds).toEqual([first.id]);

    const active = await store.list({ workspaceId: scopeId, statuses: ['active'] });
    expect(active.map((entry) => entry.id).sort()).toEqual([first.id, otherKind.id].sort());
    const survivor = active.find((entry) => entry.id === first.id);
    expect(survivor?.text).toBe('Refunds take five business days.');
    expect(survivor?.sourceRefs.sort()).toEqual(['ticket:a', 'ticket:b']);
    expect(survivor?.supersedes).toBe(second.id);

    const untouchedAgent = await store.list({
      scope: 'agent',
      scopeId: `${PREFIX}agent-consolidate`,
      statuses: ['active'],
    });
    expect(untouchedAgent.map((entry) => entry.id)).toEqual([otherScope.id]);
    expect(await store.consolidate({ workspaceId: scopeId, threshold: 0.8 })).toMatchObject({
      merged: 0,
      archivedIds: [],
    });
  });

  it('reviews proposed lessons and forgets a user', async () => {
    const store = new MemoryStore(database);
    const lesson = await store.write({
      scope: 'user',
      scopeId: `${PREFIX}user`,
      kind: 'lesson',
      text: 'After any layout change, check that no interactive element is covered.',
      sourceRefs: ['ticket:review'],
    });
    expect(lesson.status).toBe('proposed');
    const reviewed = await store.review(lesson.id, 'active');
    expect(reviewed.status).toBe('active');
    expect(await store.forgetUser(`${PREFIX}user`)).toBe(1);
    expect(await store.list({ scope: 'user', scopeId: `${PREFIX}user` })).toEqual([]);
  });
});
