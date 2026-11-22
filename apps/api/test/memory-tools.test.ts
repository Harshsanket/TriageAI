import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { Capabilities, Kernel, ToolContext } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

const embedder: NonNullable<Capabilities['embedder']> = {
  async embed(texts) {
    return {
      modelVersion: 'fake-embed',
      vectors: texts.map((text) => (/\brefunds?\b|\breturns?\b/i.test(text) ? [1, 0] : [0, 1])),
    };
  },
};

function context(agentId: string): ToolContext {
  return {
    runId: `test-memory-${Date.now()}`,
    stepId: 'memory',
    agentId,
    grantedScopes: ['memory:read', 'memory:write'],
    egressClass: 'internal',
    org: { ownsEmail: () => false },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
}

describeIfDb('agent memory tools (16.T5)', () => {
  let app: App;
  const agentId = `memory-agent-${Date.now()}`;

  beforeAll(async () => {
    app = (await buildApp({
      quiet: true,
      setup: false,
      authMode: 'disabled',
      capabilities: { embedder },
    })) as App;
  });

  afterAll(async () => {
    await app.kernel?.database.query(`DELETE FROM memories WHERE scope_id = $1`, [agentId]);
    await app.close();
  });

  it('stores a memory with its embedding and finds it by vector when lexical fails', async () => {
    const created = await app.kernel!.tools.invoke(
      'memory.create',
      {
        text: 'Refunds take five business days.',
        kind: 'fact',
        sourceRefs: ['run:seed'],
      },
      context(agentId),
      { approved: true },
    );
    expect(created.ok).toBe(true);

    const row = await app.kernel!.database.query<{
      embedding: string | null;
      embedding_model: string | null;
      embedding_dims: number | null;
    }>(
      `SELECT embedding::text AS embedding, embedding_model, embedding_dims
         FROM memories WHERE scope_id = $1`,
      [agentId],
    );
    expect(row[0]?.embedding_model).toBe('fake-embed');
    expect(row[0]?.embedding_dims).toBe(2);
    expect(row[0]?.embedding).toBeTruthy();

    const found = await app.kernel!.tools.invoke(
      'memory.search',
      { query: 'returns' },
      context(agentId),
      { approved: false },
    );
    expect(found.ok).toBe(true);
    const hits = found.ok
      ? (found.data as { hits: Array<{ text: string; score: number }> }).hits
      : [];
    expect(hits.some((hit) => hit.text.includes('Refunds take five business days'))).toBe(true);
    expect(hits[0]?.score).toBeGreaterThan(0.3);
  });

  it('rejects volatile fields and lessons stated as one-off incidents', async () => {
    const volatile = await app.kernel!.tools.invoke(
      'memory.create',
      { text: 'The customer plan is enterprise.', kind: 'fact', sourceRefs: ['run:1'] },
      context(agentId),
      { approved: true },
    );
    expect(volatile.ok).toBe(false);

    const incident = await app.kernel!.tools.invoke(
      'memory.create',
      {
        text: 'On 2026-10-01 ticket #12345 broke.',
        kind: 'lesson',
        sourceRefs: ['run:2'],
      },
      context(agentId),
      { approved: true },
    );
    expect(incident.ok).toBe(false);
  });
});
