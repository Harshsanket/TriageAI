import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, Kernel, KernelRouteDef, VectorStore } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import {
  BaseMemoryService,
  buildBaseMemoryDocuments,
  buildSystemStatusDocument,
} from '../src/services/baseMemory.js';
import { PgRetriever, PgVectorStore, type HttpEmbedder } from '../src/services/capabilities.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const DIMENSIONS = 384;
const COLLECTION = `base_memory_${Date.now()}`;

function vectorFor(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) % DIMENSIONS;
    vector[hash] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

const fakeEmbedder = {
  embed: async (texts: string[]) => ({
    vectors: texts.map(vectorFor),
    modelVersion: 'fake-embed-384',
  }),
};

describe('base memory refresh schedule (phase 24.8)', () => {
  it('refreshes the operational snapshot on the configured interval and stops cleanly', async () => {
    vi.useFakeTimers();
    const service = new BaseMemoryService(
      { info: () => undefined, warn: () => undefined, error: () => undefined },
      {} as never,
    );
    let calls = 0;
    service.refreshStatus = async () => {
      calls += 1;
    };
    service.startPeriodic(() => ({}) as Kernel, 1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toBe(3);
    service.stopPeriodic();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toBe(3);
    vi.useRealTimers();
  });
});

describe('base memory builder', () => {
  const docs = buildBaseMemoryDocuments({
    productName: 'Acme Desk',
    overlay: {
      interfaces: ['chatbot', 'ticket-solver'],
      agents: {
        chatbot: { displayName: 'Voyager' },
        'ticket-solver': { displayName: 'Pioneer' },
      },
    },
    enabledModules: ['chat', 'support', 'ai-pipeline'],
    capabilities: { generator: { adapter: 'ollama', model: 'qwen2.5:1.5b' } },
    profile: 'support',
    retentionEnabled: true,
    knowledge: { documents: 4, sources: 2, chunks: 12 },
    connections: [
      {
        name: 'GitHub',
        type: 'github',
        status: 'ready',
        baseUrl: 'https://api.github.com',
      },
    ],
    dataPolicy: { activePreset: 'strict', customClasses: 2 },
  });

  it('publishes identity and assistants without operator details', () => {
    expect(docs.publicDoc).toContain('Acme Desk');
    expect(docs.publicDoc).toContain('Voyager');
    expect(docs.publicDoc).toContain('customer conversations');
    expect(docs.publicDoc).not.toContain('qwen2.5');
    expect(docs.publicDoc).not.toContain('api.github.com');
    expect(docs.publicDoc).not.toContain('support, ai-pipeline');
  });

  it('keeps the operator document audience-specific and redacted', () => {
    expect(docs.operatorDoc).toContain('qwen2.5:1.5b');
    expect(docs.operatorDoc).toContain('api.github.com');
    expect(docs.operatorDoc).toContain('chat, support, ai-pipeline');
    expect(docs.operatorDoc).not.toMatch(/Bearer\s+\S+/i);
  });

  it('caps generated content at 20 KB', () => {
    const huge = buildBaseMemoryDocuments({
      productName: 'x'.repeat(100),
      overlay: {
        interfaces: ['chatbot'],
        agents: Object.fromEntries(
          Array.from({ length: 50 }, (_, index) => [`agent-${index}`, { displayName: 'A' }]),
        ),
      },
      enabledModules: ['chat'],
      capabilities: {},
      profile: 'core',
      retentionEnabled: false,
      knowledge: null,
      connections: [],
      dataPolicy: null,
    });
    expect(Buffer.byteLength(huge.publicDoc, 'utf8')).toBeLessThanOrEqual(20 * 1024);
  });
});

describeIfDb('managed KB sources and status tools', () => {
  let app: FastifyInstance & { kernel?: Kernel };
  let database: PostgresDatabase;
  let dir: string;
  let kernel: Kernel;
  let route: KernelRouteDef;
  const sourceIds: string[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'triageai-basemem-'));
    const configPath = path.join(dir, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'pg-queue', pollIntervalMs: 50 },
        modules: { kb: { enabled: true, options: { collection: COLLECTION } } },
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
      embedder: fakeEmbedder as unknown as HttpEmbedder,
      vectorStore,
      retriever: new PgRetriever(fakeEmbedder, vectorStore, 0.1, 0.001),
    };
    app = (await buildApp({
      quiet: true,
      configPath,
      setup: false,
      authMode: 'disabled',
      capabilities,
    })) as FastifyInstance & { kernel?: Kernel };
    kernel = app.kernel as Kernel;
    const found = kernel
      .routes()
      .find((entry) => entry.method === 'POST' && entry.url === '/api/v1/kb/managed');
    if (!found) throw new Error('managed route not registered');
    route = found;
  }, 60_000);

  afterAll(async () => {
    if (sourceIds.length > 0) {
      await database.query(`DELETE FROM vector_chunks WHERE collection = $1`, [COLLECTION]);
      await database.query(`DELETE FROM mod_kb.kb_ingest_items WHERE source_id = ANY($1)`, [
        sourceIds,
      ]);
      await database.query(
        `DELETE FROM mod_kb.kb_ingest_runs WHERE document_id IN
           (SELECT id FROM mod_kb.kb_documents WHERE source_id = ANY($1))`,
        [sourceIds],
      );
      await database.query(`DELETE FROM mod_kb.kb_documents WHERE source_id = ANY($1)`, [
        sourceIds,
      ]);
      await database.query(`DELETE FROM mod_kb.kb_sources WHERE id = ANY($1)`, [sourceIds]);
    }
    await app?.close();
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const upsert = async (body: Record<string, unknown>) =>
    (await route.handler({
      method: 'POST',
      url: '/api/v1/kb/managed',
      params: {},
      query: {},
      actor: 'system:test',
      body,
    })) as {
      source: {
        id: string;
        managedKey: string | null;
        audience: string;
        readOnly: boolean;
        version?: number;
      };
      document: { id: string; version: number };
      ingest: { changed: boolean; version: number };
      changed: boolean;
    };

  it('keeps the same managed source id and versions only changed content', async () => {
    const first = await upsert({
      managedKey: 'base-memory.public',
      title: 'About this install',
      body: '# Install\n\nWe are a ticket desk.',
      audience: 'public',
      sensitivity: 'public',
    });
    sourceIds.push(first.source.id);
    expect(first.source.managedKey).toBe('base-memory.public');
    expect(first.source.audience).toBe('public');
    expect(first.source.readOnly).toBe(true);
    expect(first.document.version).toBe(1);

    const same = await upsert({
      managedKey: 'base-memory.public',
      title: 'About this install',
      body: '# Install\n\nWe are a ticket desk.',
      audience: 'public',
      sensitivity: 'public',
    });
    expect(same.source.id).toBe(first.source.id);
    expect(same.document.version).toBe(1);
    expect(same.changed).toBe(false);

    const changed = await upsert({
      managedKey: 'base-memory.public',
      title: 'About this install',
      body: '# Install\n\nWe are a billing desk.',
      audience: 'public',
      sensitivity: 'public',
    });
    expect(changed.source.id).toBe(first.source.id);
    expect(changed.document.version).toBe(2);
    expect(changed.changed).toBe(true);

    const rows = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM mod_kb.kb_sources WHERE managed_key = 'base-memory.public'`,
    );
    expect(rows[0]?.count).toBe(1);
  }, 60_000);

  it('refuses managed writes from non-system actors', async () => {
    await expect(
      route.handler({
        method: 'POST',
        url: '/api/v1/kb/managed',
        params: {},
        query: {},
        actor: 'admin@example.com',
        body: {
          managedKey: 'base-memory.public',
          title: 'Nope',
          body: '# Nope',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('filters retrieval by audience and includes legacy chunks for public', async () => {
    const vectorStore = new PgVectorStore(database);
    await vectorStore.upsert([
      {
        id: 'aud-public',
        collection: COLLECTION,
        documentId: 'doc-public',
        text: 'public answer about billing',
        embedding: vectorFor('public answer about billing'),
        metadata: { audience: 'public', title: 'Public' },
      },
      {
        id: 'aud-operator',
        collection: COLLECTION,
        documentId: 'doc-operator',
        text: 'operator answer about model runtime',
        embedding: vectorFor('operator answer about model runtime'),
        metadata: { audience: 'operator', title: 'Operator' },
      },
      {
        id: 'aud-legacy',
        collection: COLLECTION,
        documentId: 'doc-legacy',
        text: 'legacy chunk about billing',
        embedding: vectorFor('legacy chunk about billing'),
        metadata: { title: 'Legacy' },
      },
    ]);
    const publicHits = await vectorStore.search(COLLECTION, vectorFor('billing answer'), {
      limit: 5,
      audience: 'public',
    });
    expect(publicHits.map((hit) => hit.id)).toContain('aud-public');
    expect(publicHits.map((hit) => hit.id)).toContain('aud-legacy');
    expect(publicHits.map((hit) => hit.id)).not.toContain('aud-operator');

    const operatorHits = await vectorStore.search(COLLECTION, vectorFor('billing answer'), {
      limit: 5,
      audience: 'operator',
    });
    expect(operatorHits.map((hit) => hit.id)).toContain('aud-operator');
  });

  it('exposes read-only status tools that return the dashboard facts', async () => {
    const tool = kernel.tools.get('system.get_status');
    expect(tool).toBeTruthy();
    const result = await kernel.tools.invoke(
      'system.get_status',
      {},
      {
        runId: 'test-run',
        stepId: 'status',
        actorId: 'tester',
        grantedScopes: ['system.read'],
        egressClass: 'internal',
        org: { ownsEmail: () => false },
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ database: 'up' });
      expect(typeof (result.data as { asOf: string }).asOf).toBe('string');
    }
  });

  it('renders a status snapshot with an explicit as-of stamp', () => {
    const text = buildSystemStatusDocument({
      asOf: '2026-11-01T00:00:00.000Z',
      database: 'up',
      health: { status: 'healthy', modules: [{ id: 'kb', health: 'healthy' }] },
      queue: { pending: 1, processing: 2, deadLetters: 0 },
      activity: { runsLastHour: 3, activeRuns: 1 },
      storage: { totalBytes: 2_000_000, categories: [{ category: 'chat', bytes: 1_000_000 }] },
      cost: { tokensToday: 12, callsToday: 2, todayUsd: 0 },
      modelSpeed: { avgLatencyMs: 120, p95LatencyMs: 300 },
      uptime: {
        systemUptimePct: 99.9,
        services: [{ target: 'database', uptimePct: 100, currentOk: true }],
      },
      connectedApis: [{ name: 'GitHub', type: 'github', status: 'ready' }],
    });
    expect(text).toContain('As of 2026-11-01T00:00:00.000Z');
    expect(text).toContain('Queue');
    expect(text).toContain('database: 100%');
  });
});
