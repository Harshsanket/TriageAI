import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';
import { DashboardModelUsageSchema, SystemDashboardSchema } from '@triageai/contracts';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const DB_NAME = 'triageai_dashboard_test';
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
const DOC_ID = 'dashboard-test-document';

const fakeCapabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), modelVersion: 'fake' }),
  },
  vectorStore: {
    upsert: async () => undefined,
    search: async () => [],
    deleteByDocument: async () => undefined,
  },
  retriever: {
    search: async () => ({
      chunks: [],
      gate: { sufficient: false, topScore: 0, margin: 0, threshold: 0, marginThreshold: 0 },
    }),
  },
};

async function resetDatabase(): Promise<void> {
  const admin = new PostgresDatabase(BASE_URL);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.close();
  }
}

describeIfDb('system dashboard (phase 19 v1)', () => {
  let dir: string;
  let echoConfig: string;

  beforeAll(async () => {
    await resetDatabase();
    dir = await mkdtemp(path.join(tmpdir(), 'triageai-dashboard-'));
    echoConfig = path.join(dir, 'triage.config.echo.json');
    await writeFile(
      echoConfig,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'pg-queue', pollIntervalMs: 250 },
        modules: { echo: { enabled: true }, chat: { enabled: false } },
        capabilities: {},
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    const admin = new PostgresDatabase(BASE_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => undefined);
    await admin.close();
  });

  it('aggregates host health, activity and security and omits disabled modules', async () => {
    const app = (await buildApp({
      quiet: true,
      databaseUrl: TEST_URL,
      setup: false,
      configPath: echoConfig,
      authMode: 'disabled',
    })) as FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard' });
      expect(res.statusCode).toBe(200);
      const body = SystemDashboardSchema.parse(res.json());
      expect(body.health.database).toBe('up');
      expect(body.health.status).not.toBe('down');
      expect(body.health.modules.map((module) => module.id)).toEqual(['echo']);
      expect(body.health.queue.deadLetters).toBeGreaterThanOrEqual(0);
      expect(body.knowledge).toBeNull();
      expect(body.security.authMode).toBe('disabled');
      expect(body.security.usersByRole.customer).toBeGreaterThanOrEqual(0);
      expect(body.usage.points).toEqual(expect.any(Array));
      expect(body.agents).toEqual([]);
      expect(body.pinnedDatasets).toEqual([]);

      await app.kernel!.database.query(
        `INSERT INTO agent_definitions (id, display_name, definition)
         VALUES ('agent-voyager', 'Voyager', '{"color":"#3b6fd4"}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition`,
      );
      await app.kernel!.database.query(
        `INSERT INTO cost_ledger (id, run_id, agent_id, task, provider, model, tokens_in, tokens_out, est_cost, at)
         VALUES ('cost-agent-1', 'run-agent-1', 'agent-voyager', 'agent.step', 'local', 'fake', 10, 5, 0.001, now())
         ON CONFLICT (id) DO NOTHING`,
      );
      await app.kernel!.database.query(
        `INSERT INTO model_call_traces (trace_id, run_id, task, trace)
         VALUES ('trace-usage-1', 'run-agent-1', 'answer',
                 '{"provider":"local","modelName":"fake","latencyMs":120,"timeToFirstTokenMs":40,"tokensPerSecond":8,"fallbackUsed":"none","errorCategory":null}'::jsonb)
         ON CONFLICT DO NOTHING`,
      );
      const usage = await app.inject({
        method: 'GET',
        url: '/api/v1/system/usage?window=day',
      });
      expect(usage.statusCode).toBe(200);
      const parsedUsage = DashboardModelUsageSchema.parse(usage.json());
      expect(parsedUsage.totals.tokensIn).toBeGreaterThanOrEqual(10);
      expect(parsedUsage.totals.tokensOut).toBeGreaterThanOrEqual(5);
      expect(parsedUsage.byModel[0]?.generationMeanMs).toBe(120);

      const withAgent = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard' });
      const agentBody = SystemDashboardSchema.parse(withAgent.json());
      expect(agentBody.agents[0]).toMatchObject({
        id: 'agent-voyager',
        displayName: 'Voyager',
        color: '#3b6fd4',
      });
      expect(agentBody.usage.points.at(-1)?.tokens).toBeGreaterThan(0);
      await app.kernel!.database.query(`DELETE FROM agent_definitions WHERE id = 'agent-voyager'`);
      await app.kernel!.database.query(`DELETE FROM cost_ledger WHERE id = 'cost-agent-1'`);
      await app.kernel!.database.query(
        `DELETE FROM model_call_traces WHERE trace_id = 'trace-usage-1'`,
      );
    } finally {
      await app.close();
    }
  });

  it('stores the dashboard refresh interval (default 10 minutes)', async () => {
    const app = (await buildApp({
      quiet: true,
      databaseUrl: TEST_URL,
      setup: false,
      configPath: echoConfig,
      authMode: 'disabled',
    })) as FastifyInstance;
    try {
      const defaults = await app.inject({
        method: 'GET',
        url: '/api/v1/system/dashboard-settings',
      });
      expect(defaults.json()).toMatchObject({ refreshMs: 600_000 });
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/v1/system/dashboard-settings',
        payload: { refreshMs: 300_000 },
      });
      expect(saved.json()).toMatchObject({ refreshMs: 300_000 });
      const read = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard-settings' });
      expect(read.json()).toMatchObject({ refreshMs: 300_000 });
      await app.inject({
        method: 'PUT',
        url: '/api/v1/system/dashboard-settings',
        payload: { refreshMs: 600_000 },
      });
    } finally {
      await app.close();
    }
  });

  it('reports knowledge counts only when the KB module is enabled', async () => {
    const configPath = path.join(dir, 'triage.config.kb.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'pg-queue', pollIntervalMs: 250 },
        modules: { kb: { enabled: true } },
        capabilities: {
          embedder: { adapter: 'fake' },
          vectorStore: { adapter: 'fake' },
          retriever: { adapter: 'fake' },
        },
      }),
    );
    const app = (await buildApp({
      quiet: true,
      databaseUrl: TEST_URL,
      setup: false,
      configPath,
      capabilities: fakeCapabilities,
      authMode: 'disabled',
    })) as FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };
    try {
      await app.kernel!.database.query(
        `INSERT INTO mod_kb.kb_documents (id, title, body) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
        [DOC_ID, 'Dashboard test', 'Pending approval'],
      );

      const res = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard' });
      expect(res.statusCode).toBe(200);
      const body = SystemDashboardSchema.parse(res.json());
      expect(body.knowledge).not.toBeNull();
      expect(body.knowledge?.pendingApproval).toBe(0);
      expect(body.health.modules.map((module) => module.id)).toEqual(['kb']);
    } finally {
      await app.kernel!.database.query(`DELETE FROM mod_kb.kb_documents WHERE id = $1`, [DOC_ID]);
      await app.close();
    }
  });
});
