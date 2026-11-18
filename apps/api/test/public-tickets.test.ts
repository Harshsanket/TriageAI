import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, ClassificationResult } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

function classification(): ClassificationResult {
  return {
    category: 'billing',
    confidence: 0.9,
    margin: 0.3,
    method: 'zero-shot',
    modelVersion: 'fake',
    scores: [{ category: 'billing', score: 0.9 }],
  };
}

const capabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), modelVersion: 'fake' }),
  },
  classifier: { classify: async () => classification() },
};

describeIfDb('public API ticket REST (13.T1)', () => {
  let app: FastifyInstance;
  let root: string;
  let key = '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'triageai-public-tickets-'));
    const configPath = path.join(root, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'support',
        queue: { adapter: 'pg-queue', pollIntervalMs: 100 },
        modules: {
          support: { enabled: true },
          'ai-pipeline': { enabled: true },
          'public-api': { enabled: true },
          echo: { enabled: false },
        },
        capabilities: {},
      }),
    );
    app = await buildApp({ quiet: true, configPath, capabilities, authMode: 'disabled' });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/public-api/keys',
      payload: { name: 'ticket agent' },
    });
    expect(created.statusCode).toBe(200);
    key = (created.json() as { key: string }).key;
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it('creates and reads a ticket with a scoped key', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/public-api/tickets',
      headers: { authorization: `Bearer ${key}` },
      payload: { subject: 'Key ticket', body: 'Opened through the public API key.' },
    });
    expect(created.statusCode).toBe(200);
    const { ticketId } = created.json() as { ticketId: string };
    expect(ticketId).toBeTruthy();
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/public-api/tickets/${ticketId}`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { ticket: { subject: string } }).ticket.subject).toBe('Key ticket');
  });
});
