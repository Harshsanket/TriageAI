import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

let root: string;
let configPath: string;
let app: App | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'triageai-public-api-'));
  configPath = path.join(root, 'triage.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      profile: 'core',
      queue: { adapter: 'pg-queue', pollIntervalMs: 100 },
      modules: {
        'public-api': { enabled: true },
        'ai-pipeline': { enabled: true },
        echo: { enabled: false },
      },
      capabilities: {},
    }),
  );
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

const fakeCapabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({
      vectors: texts.map(() => [0.1, 0.2, 0.3]),
      modelVersion: 'fake-embed',
    }),
  },
  retriever: {
    search: async () => ({
      chunks: [
        {
          id: 'chunk-1',
          documentId: 'doc-1',
          text: 'Refunds take five business days.',
          score: 0.94,
          metadata: { title: 'Refunds' },
        },
      ],
      gate: {
        sufficient: true,
        topScore: 0.94,
        margin: 0.5,
        threshold: 0.35,
        marginThreshold: 0.05,
      },
    }),
  },
  generator: {
    generate: async () => ({
      text: 'Refunds take five business days.',
      modelVersion: 'fake-generator',
    }),
  },
};

describeIfDb('public API (phase 13)', () => {
  it('creates a key, answers an OpenAI-compatible request with citations, and revokes it', async () => {
    app = (await buildApp({ quiet: true, configPath, capabilities: fakeCapabilities })) as App;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/public-api/keys',
      payload: { name: 'test agent' },
    });
    expect(created.statusCode).toBe(200);
    const { key, id } = created.json() as { key: string; id: string };

    const completion = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { messages: [{ role: 'user', content: 'How long do refunds take?' }] },
    });
    expect(completion.statusCode).toBe(200);
    const body = completion.json() as {
      choices: Array<{ message: { content: string } }>;
      x_triageai: { citations: string[]; runId: string };
    };
    expect(body.choices[0]?.message.content).toContain('five business days');
    expect(body.x_triageai.citations).toContain('Refunds');
    expect(body.x_triageai.runId).toBeTruthy();

    const embeddings = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${key}` },
      payload: { input: 'refund policy' },
    });
    expect(embeddings.statusCode).toBe(200);
    expect(
      (embeddings.json() as { data: Array<{ embedding: number[] }> }).data[0]?.embedding,
    ).toHaveLength(3);

    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/public-api/kb/search',
      headers: { authorization: `Bearer ${key}` },
      payload: { query: 'refund' },
    });
    expect(search.statusCode).toBe(200);
    expect((search.json() as { chunks: Array<{ id: string }> }).chunks[0]?.id).toBe('chunk-1');

    const revoked = await app.inject({
      method: 'POST',
      url: `/api/v1/public-api/keys/${id}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);

    const after = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { messages: [{ role: 'user', content: 'How long do refunds take?' }] },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'public_api.KEY_INVALID' });
  });

  it('registers an external agent, sends it a handoff and records steps', async () => {
    app = (await buildApp({ quiet: true, configPath, capabilities: fakeCapabilities })) as App;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/public-api/external-agents',
      payload: { name: 'Claude Code' },
    });
    expect(created.statusCode).toBe(200);
    const { id, key } = created.json() as { id: string; key: string };

    const handoff = await app.inject({
      method: 'POST',
      url: `/api/v1/public-api/external-agents/${id}/handoffs`,
      payload: {
        fromAgentId: 'triageai:reviewer',
        goal: 'Review ticket 42',
        handoff: { facts: [] },
      },
    });
    expect(handoff.statusCode).toBe(200);

    const received = await app.inject({
      method: 'GET',
      url: '/v1/external-agents/handoffs',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(received.statusCode).toBe(200);
    expect((received.json() as Array<{ goal: string }>)[0]?.goal).toBe('Review ticket 42');

    const step = await app.inject({
      method: 'POST',
      url: '/v1/external-agents/steps',
      headers: { authorization: `Bearer ${key}` },
      payload: { step: 'reviewing', payload: { ticketId: '42' } },
    });
    expect(step.statusCode).toBe(200);
    expect(step.json()).toMatchObject({ accepted: true, agentId: id });
  });

  it('refuses requests without a key', async () => {
    app = (await buildApp({ quiet: true, configPath, capabilities: fakeCapabilities })) as App;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'public_api.KEY_REQUIRED' });
  });
});
