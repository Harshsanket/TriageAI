import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';

import type { Capabilities, ClassificationResult, Kernel } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const SUPPORT_CONFIG = path.resolve(process.cwd(), '../../config/presets/support.json');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

type App = FastifyInstance & { kernel?: Kernel };

function classification(): ClassificationResult {
  return {
    category: 'known_troubleshooting',
    confidence: 0.93,
    margin: 0.4,
    method: 'zero-shot',
    modelVersion: 'fake-classifier',
    scores: [{ category: 'known_troubleshooting', score: 0.93 }],
  };
}

async function clean(database: PostgresDatabase): Promise<void> {
  await database.query(`DELETE FROM eval_reports`);
  await database.query(`DELETE FROM model_assets`);
  await database.query(`DELETE FROM datasets`);
  await database.query(`DELETE FROM candidate_examples`);
  await database.query(`DELETE FROM audit_events`);
  await database.query(`DELETE FROM support_tickets`);
  await database.query(
    `DELETE FROM workflow_runs WHERE workflow_id IN ('support.triage','support.auto_reply')`,
  );
}

describeIfDb('model registry promotion + rollback (phase 6)', () => {
  let app: App;
  let database: PostgresDatabase;

  beforeEach(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await clean(database);
    const capabilities: Capabilities = {
      classifier: { classify: async () => classification() },
    };
    app = (await buildApp({ quiet: true, configPath: SUPPORT_CONFIG, capabilities })) as App;
  });

  afterEach(async () => {
    await app.close();
    await database.close();
  });

  async function register(component: string, name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models',
      payload: { component, name, actor: 'test-admin' },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function report(
    subjectModelId: string,
    metrics: Record<string, number>,
    passes = true,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/models/eval-reports',
      payload: {
        generatedAt: new Date().toISOString(),
        subjectModelId,
        suites: [{ suite: 'classification', status: passes ? 'passed' : 'failed', metrics }],
        metrics,
        passes,
      },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function promote(id: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/models/${id}/promote`,
      payload: { actor: 'test-admin' },
    });
    return res.statusCode;
  }

  async function activate(name: string, metrics: Record<string, number>): Promise<string> {
    const id = await register('classifier', name);
    await report(id, metrics);
    expect(await promote(id)).toBe(200);
    return id;
  }

  async function decisionForRun(runId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const rows = await database.query<{ adapter_versions: Record<string, unknown> }>(
        `SELECT dr.adapter_versions
         FROM decision_records dr
         JOIN stage_runs sr ON sr.id = dr.stage_run_id
         WHERE dr.run_id = $1 AND sr.kind = 'ai.classify'
         LIMIT 1`,
        [runId],
      );
      if (rows[0]) return rows[0].adapter_versions;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ai.classify decision ${runId}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function ticketDecision(): Promise<{
    runId: string;
    adapterVersions: Record<string, unknown>;
  }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: 'App crashes', body: 'The app crashes on startup', requester: 'test' },
    });
    expect(res.statusCode).toBe(200);
    const { runId } = res.json() as { runId: string };
    return { runId, adapterVersions: await decisionForRun(runId) };
  }

  it('blocks a worse eval, promotes a better one, and rollback affects the next run', async () => {
    const baseline = await activate('baseline-classifier', {
      macroF1: 0.8,
      falseAutoRoutingCount: 0,
    });

    const before = await ticketDecision();
    expect(before.adapterVersions).toMatchObject({
      classifier: 'baseline-classifier',
      classifierAssetId: baseline,
    });

    const candidate = await register('classifier', 'candidate-classifier');
    expect(await promote(candidate)).toBe(409);
    await report(candidate, { macroF1: 0.7, falseAutoRoutingCount: 0 });
    expect(await promote(candidate)).toBe(409);
    await report(candidate, { macroF1: 0.85, falseAutoRoutingCount: 0 });
    expect(await promote(candidate)).toBe(200);

    const states = await database.query<{ id: string; status: string }>(
      `SELECT id, status FROM model_assets WHERE component = 'classifier' ORDER BY created_at`,
    );
    expect(states).toEqual([
      { id: baseline, status: 'rolled_back' },
      { id: candidate, status: 'active' },
    ]);

    const afterPromotion = await ticketDecision();
    expect(afterPromotion.adapterVersions).toMatchObject({
      classifier: 'candidate-classifier',
      classifierAssetId: candidate,
    });

    const rollback = await app.inject({
      method: 'POST',
      url: `/api/v1/models/${baseline}/rollback`,
      payload: { actor: 'test-admin', reason: 'regression' },
    });
    expect(rollback.statusCode).toBe(200);

    const afterRollback = await ticketDecision();
    expect(afterRollback.adapterVersions).toMatchObject({
      classifier: 'baseline-classifier',
      classifierAssetId: baseline,
    });

    const audit = await database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action IN ('model.promoted','model.rolled_back') ORDER BY created_at`,
    );
    expect(audit.map((row) => row.action).sort()).toEqual([
      'model.promoted',
      'model.promoted',
      'model.rolled_back',
    ]);
  });

  it('safety gate: any false auto-routing blocks promotion even with a passing report', async () => {
    const baseline = await activate('baseline-classifier', {
      macroF1: 0.8,
      falseAutoRoutingCount: 0,
    });
    const unsafe = await register('classifier', 'unsafe-classifier');
    await report(unsafe, { macroF1: 0.95, falseAutoRoutingCount: 1 });
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/models/${unsafe}/promote`,
      payload: { actor: 'test-admin' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.stringify(blocked.json())).toContain('false auto-routing');

    const active = await database.query<{ id: string }>(
      `SELECT id FROM model_assets WHERE status = 'active' AND component = 'classifier'`,
    );
    expect(active).toEqual([{ id: baseline }]);
  });

  it('requires an eval report before promotion', async () => {
    const id = await register('classifier', 'unreported-classifier');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/models/${id}/promote`,
      payload: { actor: 'test-admin' },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).toContain('no eval report');
  });
});
