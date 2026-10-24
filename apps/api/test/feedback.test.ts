import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';

import type { Kernel } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const CORE_CONFIG = path.resolve(process.cwd(), '../../triage.config.json');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

type App = FastifyInstance & { kernel?: Kernel };

interface CandidateBody {
  id: string;
  status: string;
  provenance: Record<string, unknown>;
}

async function clean(database: PostgresDatabase): Promise<void> {
  await database.query(`DELETE FROM eval_reports`);
  await database.query(`DELETE FROM model_assets`);
  await database.query(`DELETE FROM datasets`);
  await database.query(`DELETE FROM candidate_examples`);
  await database.query(`DELETE FROM audit_events`);
  await database.query(`DELETE FROM workflow_runs WHERE id LIKE 'testfeedback-%'`);
}

describeIfDb('feedback review + datasets (phase 6)', () => {
  let app: App;
  let database: PostgresDatabase;

  beforeEach(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await clean(database);
    app = (await buildApp({ quiet: true, configPath: CORE_CONFIG })) as App;
  });

  afterEach(async () => {
    await app.close();
    await database.close();
  });

  async function createCandidate(
    input: Record<string, unknown>,
    gold: Record<string, unknown>,
    options: { runId?: string; method?: string } = {},
  ): Promise<CandidateBody> {
    if (options.runId) {
      await database.query(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version, status)
         VALUES ($1, 'testfeedback.seed', '0.1.0', 'SUCCEEDED')
         ON CONFLICT (id) DO NOTHING`,
        [options.runId],
      );
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/system/candidates',
      payload: {
        runId: options.runId,
        input,
        gold,
        actor: 'agent-1',
        method: options.method ?? 'mistake',
        reason: 'reviewed in UI',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as CandidateBody;
  }

  async function review(id: string, status: 'approved' | 'rejected'): Promise<CandidateBody> {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/system/candidates/${id}`,
      payload: { status, actor: 'reviewer-1', method: 'better_answer', note: 'looks right' },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as CandidateBody;
  }

  it('reviews candidates immutably and audits the decisions', async () => {
    const first = await createCandidate({ text: 'billing issue' }, { category: 'billing' });
    expect(first.status).toBe('proposed');
    expect(first.provenance).toMatchObject({ method: 'mistake' });

    const approved = await review(first.id, 'approved');
    expect(approved.status).toBe('approved');
    expect(approved.provenance.review).toMatchObject({
      decision: 'approved',
      actor: 'reviewer-1',
      method: 'better_answer',
    });

    const again = await app.inject({
      method: 'PATCH',
      url: `/api/v1/system/candidates/${first.id}`,
      payload: { status: 'rejected', actor: 'reviewer-2' },
    });
    expect(again.statusCode).toBe(409);

    const audit = await database.query<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_events WHERE subject = $1`,
      [first.id],
    );
    expect(audit).toEqual([{ action: 'feedback.reviewed', actor: 'reviewer-1' }]);
  });

  it('builds a deterministic dataset from approved examples only', async () => {
    const ids: Array<{ id: string; label: string; runId: string }> = [];
    const labels = ['billing', 'security'] as const;
    for (const [labelIndex, label] of labels.entries()) {
      for (let index = 0; index < 5; index += 1) {
        const runId = index < 2 ? `testfeedback-${label}-a` : `testfeedback-${label}-${index}`;
        const created = await createCandidate(
          { text: `${label}-${index}` },
          { category: label },
          { runId, method: index % 2 === 0 ? 'mistake' : 'better_answer' },
        );
        // Deterministic age so the shared run is the oldest group (whole-run
        // grouping must stay intact without breaking per-label ratios).
        await database.query(`UPDATE candidate_examples SET created_at = $2 WHERE id = $1`, [
          created.id,
          new Date(Date.UTC(2026, 0, 1 + labelIndex, 0, index)).toISOString(),
        ]);
        await review(created.id, 'approved');
        ids.push({ id: created.id, label, runId });
      }
    }
    const rejected = await createCandidate({ text: 'reject me' }, { category: 'billing' });
    await review(rejected.id, 'rejected');

    const built = await app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      payload: { purpose: 'classifier', createdBy: 'reviewer-1' },
    });
    expect(built.statusCode).toBe(201);
    const dataset = built.json() as {
      id: string;
      version: string;
      sha256: string;
      splits: Record<string, string[]>;
      counts: { train: number; val: number; test: number };
    };
    expect(dataset.version).toBe('v1');
    expect(dataset.counts).toEqual({ train: 6, val: 2, test: 2 });
    expect(
      dataset.splits.train.length + dataset.splits.val.length + dataset.splits.test.length,
    ).toBe(10);
    expect([...dataset.splits.train, ...dataset.splits.val, ...dataset.splits.test]).not.toContain(
      rejected.id,
    );

    // Same-run examples stay together; no source run appears in two splits.
    const splitOf = new Map<string, string>();
    for (const split of ['train', 'val', 'test'] as const) {
      for (const id of dataset.splits[split]) splitOf.set(id, split);
    }
    for (const runId of ['testfeedback-billing-a', 'testfeedback-security-a']) {
      const members = ids
        .filter((entry) => entry.runId === runId)
        .map((entry) => splitOf.get(entry.id));
      expect(new Set(members).size).toBe(1);
    }

    const rebuilt = await app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      payload: { purpose: 'classifier', createdBy: 'reviewer-2' },
    });
    expect(rebuilt.statusCode).toBe(200);
    expect(rebuilt.json()).toMatchObject({ id: dataset.id, sha256: dataset.sha256, version: 'v1' });

    const exported = await app.inject({
      method: 'GET',
      url: `/api/v1/datasets/${dataset.id}/export`,
    });
    expect(exported.statusCode).toBe(200);
    const body = exported.json() as { examples: Array<{ id: string; split: string }> };
    expect(body.examples).toHaveLength(10);
    expect(new Set(body.examples.map((entry) => entry.split))).toEqual(
      new Set(['train', 'val', 'test']),
    );

    const audit = await database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'dataset.built'`,
    );
    expect(audit).toHaveLength(1);
  });
});
