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
      // 19.T5/T6 additive metrics start honest and empty on a fresh install.
      expect(body.wakeUps.total).toBe(0);
      expect(body.wakeUps.averageReReadRatio).toBeNull();
      expect(body.taskCompletion.rate).toBeNull();
      expect(body.unitCosts.costPerTokenUsd).toBeNull();
      expect(body.schemaValidity.available).toBe(false);
      expect(body.toolCalls.available).toBe(false);
      expect(body.retrieval.available).toBe(false);
      expect(body.caches.prompt.tokensCached).toBe(0);
      expect(body.caches.generation.available).toBe(false);
      expect(body.contextPacks.available).toBe(false);
      expect(body.routing.calls).toBe(0);
      expect(body.responseCache.hit).toBe(false);

      await app.kernel!.database.query(
        `INSERT INTO agent_definitions (id, display_name, definition)
         VALUES ('agent-voyager', 'Voyager', '{"color":"#3b6fd4"}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition`,
      );
      await app.kernel!.database.query(
        `INSERT INTO cost_ledger (id, run_id, agent_id, task, provider, model, tokens_in, tokens_out, est_cost, at)
         VALUES ('cost-agent-1', 'run-agent-1', 'agent-voyager', 'agent.step', 'local', 'fake', 10, 5, 0.001, now())
         ON CONFLICT DO NOTHING`,
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

  it('computes the 19.4 metrics from ledger, decision, trace, schedule and agent rows', async () => {
    const app = (await buildApp({
      quiet: true,
      databaseUrl: TEST_URL,
      setup: false,
      configPath: echoConfig,
      authMode: 'disabled',
    })) as FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };
    const database = app.kernel!.database;
    try {
      await database.query(
        `INSERT INTO workflow_runs
           (id, workflow_id, workflow_version, trigger, status, input, created_at, started_at, finished_at)
         VALUES
           ('dash-run-wake', 'echo.schedule', '1', 'schedule', 'SUCCEEDED',
            '{"agentId":"dash-agent"}'::jsonb, now(), now(), now()),
           ('dash-run-fail', 'echo.run', '1', 'endpoint', 'FAILED',
            '{}'::jsonb, now(), now(), now())
         ON CONFLICT (id) DO NOTHING`,
      );
      await database.query(
        `INSERT INTO cost_ledger
           (id, run_id, agent_id, task, provider, model, tokens_in, tokens_out, tokens_cached, est_cost, at)
         VALUES
           ('dash-cost-1', 'dash-run-wake', 'dash-agent', 'answer', 'local', 'fake', 100, 10, 20, 0.01, now()),
           ('dash-cost-2', 'dash-run-fail', NULL, 'answer', 'local', 'fake', 20, 5, 0, 0.002, now())
         ON CONFLICT DO NOTHING`,
      );
      await database.query(
        `INSERT INTO model_call_traces (trace_id, run_id, task, trace, at)
         VALUES
           ('dash-trace-ok', 'dash-run-wake', 'answer',
            '{"provider":"local","modelName":"fake","routingReason":"cheapest_above_quality_floor","fallbackUsed":"none","schemaValidFirstTry":true,"toolCalls":[{"toolName":"echo","toolArgs":{},"status":"ok"}],"context":{"windowTokens":8192,"usedTokens":4096,"percent":50}}'::jsonb,
            now()),
           ('dash-trace-fail', 'dash-run-fail', 'answer',
            '{"provider":"local","modelName":"fake","routingReason":"configured_primary","fallbackUsed":"fallback_model","schemaValidFirstTry":false,"toolCalls":[{"toolName":"echo","toolArgs":{},"status":"error"}],"context":{"windowTokens":8192,"usedTokens":8192,"percent":100}}'::jsonb,
            now() - interval '1 minute')
         ON CONFLICT DO NOTHING`,
      );
      await database.query(
        `INSERT INTO stage_runs (id, run_id, stage_id, kind, status)
         VALUES
           ('dash-stage-retrieve', 'dash-run-wake', 'retrieve', 'ai.retrieve', 'SUCCEEDED'),
           ('dash-stage-finalize', 'dash-run-wake', 'finalize', 'ai.finalize_answer', 'SUCCEEDED'),
           ('dash-stage-generate', 'dash-run-wake', 'generate', 'ai.generate', 'SUCCEEDED'),
           ('dash-stage-deliver', 'dash-run-wake', 'deliver', 'chat.deliver', 'SUCCEEDED')
         ON CONFLICT DO NOTHING`,
      );
      await database.query(
        `INSERT INTO decision_records
           (id, run_id, stage_run_id, workflow_id, workflow_version, module_id, module_version,
            evidence, deterministic)
         VALUES
           ('dash-dec-retrieve', 'dash-run-wake', 'dash-stage-retrieve', 'echo.schedule', '1',
            'ai-pipeline', '1', '{"selectedChunks":2}'::jsonb, '{}'::jsonb),
           ('dash-dec-finalize', 'dash-run-wake', 'dash-stage-finalize', 'echo.schedule', '1',
            'ai-pipeline', '1', '{"grounding":{"cited":true}}'::jsonb, '{}'::jsonb),
           ('dash-dec-generate', 'dash-run-wake', 'dash-stage-generate', 'echo.schedule', '1',
            'ai-pipeline', '1', '{}'::jsonb, '{"cacheHit":true}'::jsonb),
           ('dash-dec-deliver', 'dash-run-wake', 'dash-stage-deliver', 'echo.schedule', '1',
            'chat', '1', '{}'::jsonb, '{"refused":true}'::jsonb)
         ON CONFLICT DO NOTHING`,
      );
      await database.query(
        `INSERT INTO schedule_state (schedule_id, workflow_id, last_status, skipped_overlap, updated_at)
         VALUES ('dash-schedule', 'echo.schedule', 'no_change', 1, now())
         ON CONFLICT (schedule_id) DO UPDATE SET last_status = EXCLUDED.last_status`,
      );
      await database.query(
        `INSERT INTO schedule_runs
           (id, schedule_id, workflow_id, run_id, due_at, started_at, outcome, manual, useful, cost)
         VALUES
           ('dash-sched-run-1', 'dash-schedule', 'echo.schedule', 'dash-run-wake',
            now() - interval '1 hour', now() - interval '1 hour', 'no_change', false, false, 0.01),
           ('dash-sched-run-2', 'dash-schedule', 'echo.schedule', 'dash-run-wake',
            now() - interval '2 hours', now() - interval '2 hours', 'succeeded', false, true, 0.02)
         ON CONFLICT (id) DO NOTHING`,
      );
      await database.query(
        `INSERT INTO agent_definitions (id, display_name, definition)
         VALUES ('dash-agent', 'Dashboard Agent', '{"color":"#2f8f6b","maxSteps":5}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition`,
      );
      await database.query(
        `INSERT INTO agent_checkpoints (run_id, state, updated_at)
         VALUES ('dash-run-wake', '{"goal":"check the dashboard","step":2,"status":"running","notes":[]}'::jsonb, now())
         ON CONFLICT (run_id) DO UPDATE SET state = EXCLUDED.state`,
      );
      await database.query(
        `INSERT INTO agent_steps (id, run_id, step_no, decision, payload)
         VALUES ('dash-agent-step', 'dash-run-wake', 1, 'call_tool',
                 '{"decision":"call_tool","reason":"read","context":{"tokens":{"total":100},"included":[{"source":"memory","tokens":60,"used":true},{"source":"state","tokens":40,"used":true}]}}'::jsonb)
         ON CONFLICT DO NOTHING`,
      );
      await database.query(
        `INSERT INTO shared_state (scope_type, scope_id, key, value)
         VALUES ('agent', 'dash-agent', 'paused', '{"paused":true}'::jsonb)
         ON CONFLICT (scope_type, scope_id, key) DO UPDATE SET value = EXCLUDED.value`,
      );

      const res = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard?fresh=1' });
      expect(res.statusCode).toBe(200);
      const body = SystemDashboardSchema.parse(res.json());

      expect(body.wakeUps.total).toBeGreaterThanOrEqual(2);
      expect(body.wakeUps.points.some((point) => point.byTrigger.schedule > 0)).toBe(true);
      expect(body.wakeUps.probes).toBeGreaterThanOrEqual(1);
      expect(body.wakeUps.averageReReadRatio).toBeGreaterThan(0);
      expect(body.wakeUps.topRuns.length).toBeGreaterThan(0);
      expect(body.wakeUps.topRuns[0]?.contextParts.length).toBeGreaterThan(0);

      expect(body.taskCompletion.started).toBeGreaterThanOrEqual(2);
      expect(body.taskCompletion.rate).toBeGreaterThan(0);
      expect(body.unitCosts.costPerTokenUsd).toBeGreaterThan(0);
      expect(body.unitCosts.costPerStepUsd).toBeGreaterThan(0);

      expect(body.schemaValidity.calls).toBeGreaterThanOrEqual(2);
      expect(body.schemaValidity.rate).toBe(0.5);
      expect(body.toolCalls.calls).toBeGreaterThanOrEqual(2);
      expect(body.toolCalls.successRate).toBe(0.5);
      expect(body.retrieval.available).toBe(true);
      expect(body.retrieval.hitRate).toBe(1);

      expect(body.routing.calls).toBeGreaterThanOrEqual(2);
      expect(body.routing.fallbacks).toBeGreaterThanOrEqual(1);
      expect(body.routing.escalations).toBeGreaterThanOrEqual(1);
      expect(body.routing.byReason.some((entry) => entry.reason === 'configured_primary')).toBe(
        true,
      );
      expect(body.caches.generation.available).toBe(true);
      expect(body.caches.generation.hits).toBeGreaterThanOrEqual(1);
      expect(body.caches.prompt.tokensCached).toBeGreaterThanOrEqual(20);

      expect(body.routines.usefulRuns).toBeGreaterThanOrEqual(1);
      expect(body.routines.usefulRunRate).toBeGreaterThan(0);
      expect(body.routines.bySchedule[0]?.suggestion).toEqual(expect.any(String));
      expect(body.contextPacks.totalContexts).toBeGreaterThanOrEqual(1);
      expect(body.contextPacks.contextLimit).toBe(8192);

      const agent = body.agents.find((entry) => entry.id === 'dash-agent');
      expect(agent).toMatchObject({
        status: 'paused',
        currentStep: 2,
        stepLimit: 5,
        contextPercent: 50,
      });
      expect(agent?.watchdog).toMatchObject({ paused: true, flag: 'paused' });
      expect(body.quality.refusalRate).toBeGreaterThan(0);
    } finally {
      await database.query(
        `DELETE FROM shared_state WHERE scope_type = 'agent' AND scope_id = 'dash-agent'`,
      );
      await database.query(`DELETE FROM agent_steps WHERE id = 'dash-agent-step'`);
      await database.query(`DELETE FROM agent_checkpoints WHERE run_id = 'dash-run-wake'`);
      await database.query(`DELETE FROM agent_definitions WHERE id = 'dash-agent'`);
      await database.query(`DELETE FROM schedule_runs WHERE schedule_id = 'dash-schedule'`);
      await database.query(`DELETE FROM schedule_state WHERE schedule_id = 'dash-schedule'`);
      await database.query(`DELETE FROM model_call_traces WHERE trace_id LIKE 'dash-trace-%'`);
      await database.query(`DELETE FROM cost_ledger WHERE id LIKE 'dash-cost-%'`);
      await database.query(
        `DELETE FROM workflow_runs WHERE id IN ('dash-run-wake', 'dash-run-fail')`,
      );
      await app.close();
    }
  });

  it('caches the aggregate for five seconds and bypasses it with ?fresh=1', async () => {
    const previous = process.env.TRIAGEAI_DASHBOARD_CACHE;
    process.env.TRIAGEAI_DASHBOARD_CACHE = '1';
    const app = (await buildApp({
      quiet: true,
      databaseUrl: TEST_URL,
      setup: false,
      configPath: echoConfig,
      authMode: 'disabled',
    })) as FastifyInstance;
    try {
      const first = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard' });
      const firstBody = SystemDashboardSchema.parse(first.json());
      expect(firstBody.responseCache.hit).toBe(false);

      const second = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard' });
      const secondBody = SystemDashboardSchema.parse(second.json());
      expect(secondBody.responseCache.hit).toBe(true);
      expect(secondBody.responseCache.hits).toBe(1);
      expect(secondBody.generatedAt).toBe(firstBody.generatedAt);

      const fresh = await app.inject({
        method: 'GET',
        url: '/api/v1/system/dashboard?fresh=1',
      });
      const freshBody = SystemDashboardSchema.parse(fresh.json());
      expect(freshBody.responseCache.hit).toBe(false);
      expect(freshBody.responseCache.misses).toBeGreaterThan(secondBody.responseCache.misses);
    } finally {
      if (previous === undefined) delete process.env.TRIAGEAI_DASHBOARD_CACHE;
      else process.env.TRIAGEAI_DASHBOARD_CACHE = previous;
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
