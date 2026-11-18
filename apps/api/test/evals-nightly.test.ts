import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import {
  EVAL_AUTO_ROLLBACK_KEY,
  EVAL_BASELINES_KEY,
  EVAL_SCORE_FLOOR_KEY,
  readEvalBaselines,
  runNightlyEvals,
} from '../src/services/evals.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const ACTIVE_MODEL = 'evals-active-model';
const PREVIOUS_MODEL = 'evals-previous-model';

describeIfDb('nightly regression + drift + opt-in auto-rollback (phase 18.T2)', () => {
  let app: FastifyInstance & { kernel?: Kernel };

  beforeAll(async () => {
    app = (await buildApp({ quiet: true })) as FastifyInstance & { kernel?: Kernel };
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    if (!app?.kernel) return;
    const database = app.kernel.database;
    await database.query(`DELETE FROM eval_reports WHERE id LIKE 'nightly-%'`);
    await database.query(`DELETE FROM model_assets WHERE id IN ($1, $2)`, [
      ACTIVE_MODEL,
      PREVIOUS_MODEL,
    ]);
    await database.query(`DELETE FROM settings WHERE key IN ($1, $2, $3)`, [
      EVAL_BASELINES_KEY,
      EVAL_AUTO_ROLLBACK_KEY,
      EVAL_SCORE_FLOOR_KEY,
    ]);
    await database.query(
      `DELETE FROM audit_events WHERE action LIKE 'alert.eval%' OR action LIKE 'evals.%'`,
    );
  }

  async function seed(): Promise<void> {
    const database = app.kernel!.database;
    await database.query(
      `INSERT INTO model_assets (id, component, name, status, promoted_at)
       VALUES ($1, 'classifier', 'previous', 'rolled_back', now() - interval '2 days'),
              ($2, 'classifier', 'active', 'active', now() - interval '1 day')`,
      [PREVIOUS_MODEL, ACTIVE_MODEL],
    );
    const scores = [0.9, 0.9, 0.9, 0.4, 0.3, 0.2];
    for (const [index, score] of scores.entries()) {
      await database.query(
        `INSERT INTO eval_reports
           (id, subject_model_id, suites, metrics, passes, generated_at, created_at)
         VALUES ($1, $2, '[]'::jsonb, $3, true,
                 now() - ($4 || ' minutes')::interval,
                 now() - ($4 || ' minutes')::interval)`,
        [`nightly-${ulid()}`, ACTIVE_MODEL, { groundedness: score }, String(10 - index)],
      );
    }
  }

  it('maintains a rolling baseline and audits drift when auto-rollback is off', async () => {
    await seed();
    const calls: Array<{ component: string; modelId: string | null; reason: string }> = [];
    const result = await runNightlyEvals({
      database: app.kernel!.database,
      now: new Date('2026-11-11T02:00:00Z'),
      rollback: async (args) => {
        calls.push(args);
        return { rolledBackTo: PREVIOUS_MODEL };
      },
    });

    expect(result).toMatchObject({
      reports: 6,
      newReports: 6,
      currentScore: 0.2,
      rollbackDue: true,
      autoRollbackEnabled: false,
    });
    expect(result.drift.drift).toBe(true);
    expect(result.rollback).toMatchObject({
      attempted: false,
      performed: false,
      reason: 'auto_rollback_disabled',
    });
    expect(calls).toHaveLength(0);

    const baselines = await readEvalBaselines(app.kernel!.database);
    expect(baselines.scores).toEqual([0.9, 0.9, 0.9, 0.4, 0.3, 0.2]);
    expect(baselines.baseline).toMatchObject({ samples: 5 });
    expect(baselines.updatedAt).toBe('2026-11-11T02:00:00.000Z');

    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'alert.eval_drift'`,
    );
    expect(audit).toHaveLength(1);
  });

  it('rolls back through the injected registry rollback only when opted in', async () => {
    await seed();
    await app.kernel!.database.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, 'true'::jsonb, 'test')`,
      [EVAL_AUTO_ROLLBACK_KEY],
    );
    const calls: Array<{ component: string; modelId: string | null; reason: string }> = [];
    const rollback = async (args: {
      component: string;
      modelId: string | null;
      reason: string;
    }) => {
      calls.push(args);
      return { rolledBackTo: PREVIOUS_MODEL };
    };

    const result = await runNightlyEvals({
      database: app.kernel!.database,
      rollback,
    });
    expect(result).toMatchObject({
      autoRollbackEnabled: true,
      rollbackDue: true,
      rollback: {
        attempted: true,
        performed: true,
        rolledBackTo: PREVIOUS_MODEL,
        reason: 'rolled_back',
      },
    });
    expect(calls).toEqual([
      {
        component: 'classifier',
        modelId: ACTIVE_MODEL,
        reason: expect.stringContaining('below floor'),
      },
    ]);

    // No new reports: a restart must not roll back again on the same window.
    const repeat = await runNightlyEvals({
      database: app.kernel!.database,
      rollback,
    });
    expect(repeat.newReports).toBe(0);
    expect(repeat.rollback.attempted).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('records an audited alert when no previous passing model exists', async () => {
    await seed();
    await app.kernel!.database.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, 'true'::jsonb, 'test')`,
      [EVAL_AUTO_ROLLBACK_KEY],
    );
    const result = await runNightlyEvals({
      database: app.kernel!.database,
      rollback: async () => null,
    });
    expect(result.rollback).toMatchObject({
      attempted: true,
      performed: false,
      rolledBackTo: null,
      reason: 'no_previous_passing_model',
    });
    expect(result.alerts).toContain('eval_rollback_unavailable');
    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'alert.eval_rollback_unavailable'`,
    );
    expect(audit).toHaveLength(1);
  });

  it('uses the real registry rollback when no fake is injected', async () => {
    await seed();
    await app.kernel!.database.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, 'true'::jsonb, 'test')`,
      [EVAL_AUTO_ROLLBACK_KEY],
    );
    let invalidated = false;
    const result = await runNightlyEvals({
      database: app.kernel!.database,
      registry: {
        invalidate: () => {
          invalidated = true;
        },
      },
    });
    expect(result.rollback).toMatchObject({
      attempted: true,
      performed: true,
      rolledBackTo: PREVIOUS_MODEL,
      reason: 'rolled_back',
    });
    expect(invalidated).toBe(true);
    const states = await app.kernel!.database.query<{ id: string; status: string }>(
      `SELECT id, status FROM model_assets WHERE id IN ($1, $2) ORDER BY id`,
      [ACTIVE_MODEL, PREVIOUS_MODEL],
    );
    expect(states).toEqual(
      [
        { id: ACTIVE_MODEL, status: 'rolled_back' },
        { id: PREVIOUS_MODEL, status: 'active' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    const audit = await app.kernel!.database.query<{ payload: { auto: boolean } }>(
      `SELECT payload FROM audit_events WHERE action = 'model.rolled_back'`,
    );
    expect(audit[0]?.payload.auto).toBe(true);
  });
});
