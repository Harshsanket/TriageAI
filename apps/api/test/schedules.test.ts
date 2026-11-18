import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import { ruleFor } from '../src/platform/auth/rbac.js';
import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const SCHEDULE_ID = 'test.api.schedule';

describe('schedule routes are admin-only (19.T8)', () => {
  it('declares explicit admin rules for list/run/receipt/accept', () => {
    for (const [method, path] of [
      ['GET', '/api/v1/system/schedules'],
      ['POST', '/api/v1/system/schedules/test.api.schedule/run'],
      ['GET', '/api/v1/system/schedules/test.api.schedule/receipt'],
      ['PUT', '/api/v1/system/schedules/test.api.schedule/suggestion'],
    ] as const) {
      expect(ruleFor(method, path).roles).toEqual(['admin']);
    }
  });
});

describeIfDb('schedules API (19.T8)', () => {
  let app: FastifyInstance;

  async function cleanup(): Promise<void> {
    const db = app.kernel?.database;
    if (!db) return;
    await db.query(`DELETE FROM schedule_runs WHERE schedule_id = $1`, [SCHEDULE_ID]);
    await db.query(`DELETE FROM schedule_state WHERE schedule_id = $1`, [SCHEDULE_ID]);
    await db.query(`DELETE FROM workflow_runs WHERE workflow_id = $1`, [SCHEDULE_ID]);
    await db.query(`DELETE FROM settings WHERE key = 'schedules.suggestions'`);
  }

  beforeAll(async () => {
    app = await buildApp({
      quiet: true,
      setup: false,
      authMode: 'disabled',
      useOverlay: false,
      rateLimit: { max: 0 },
    });
    const kernel = app.kernel!;
    kernel.workflowEngine.registerStageHandler('test.schedule.step', {
      execute: async () => ({ output: { sent: [{ id: ulid() }] } }),
    });
    kernel.workflowEngine.register(
      {
        id: SCHEDULE_ID,
        version: '0.1.0',
        module: 'test',
        trigger: {
          type: 'schedule',
          config: {
            cron: '0 0 1 1 *',
            probe: { kind: 'watermark', read: 'table:workflow_runs:count' },
          },
        },
        stages: [{ id: 'run', kind: 'test.schedule.step' }],
      },
      'test',
      '0.1.0',
    );
    await kernel.scheduler.start();
    await cleanup();
    await kernel.scheduler.start();
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  it('lists the schedule with receipt, runs manually and accepts a suggestion', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/system/schedules' });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      schedules: Array<{
        id: string;
        cron: string | null;
        managed: boolean;
        nextRunAt: string | null;
        receipt: { runs: number; suggestion: string };
      }>;
    };
    const schedule = body.schedules.find((entry) => entry.id === SCHEDULE_ID);
    expect(schedule).toMatchObject({ cron: '0 0 1 1 *', managed: true });
    expect(schedule?.nextRunAt).toBeTruthy();
    expect(schedule?.receipt.suggestion).toBe('retire');

    const manual = await app.inject({
      method: 'POST',
      url: `/api/v1/system/schedules/${SCHEDULE_ID}/run`,
    });
    expect(manual.statusCode).toBe(200);
    const { runId } = manual.json() as { runId: string };
    const deadline = Date.now() + 15_000;
    for (;;) {
      const rows = await app.kernel!.database.query<{ status: string }>(
        `SELECT status FROM workflow_runs WHERE id = $1`,
        [runId],
      );
      if (rows[0]?.status === 'SUCCEEDED') break;
      if (Date.now() > deadline) throw new Error('manual run did not finish');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'schedule.run' AND subject = $1`,
      [SCHEDULE_ID],
    );
    expect(audit.length).toBeGreaterThan(0);

    const now = Date.now();
    for (const row of [
      { outcome: 'succeeded', useful: true, cost: 1.5, days: 1, neededHuman: false },
      { outcome: 'no_change', useful: false, cost: 0, days: 2, neededHuman: false },
      { outcome: 'failed', useful: false, cost: 0, days: 3, neededHuman: false },
      { outcome: 'skipped_overlap', useful: false, cost: 0, days: 4, neededHuman: false },
    ]) {
      await app.kernel!.database.query(
        `INSERT INTO schedule_runs
           (id, schedule_id, workflow_id, due_at, started_at, finished_at, outcome,
            manual, useful, needed_human, cost)
         VALUES ($1, $2, $3, $4, $4, $4, $5, false, $6, $7, $8)`,
        [
          ulid(),
          SCHEDULE_ID,
          SCHEDULE_ID,
          new Date(now - row.days * 86_400_000).toISOString(),
          row.outcome,
          row.useful,
          row.neededHuman,
          row.cost,
        ],
      );
    }

    const receipt = await app.inject({
      method: 'GET',
      url: `/api/v1/system/schedules/${SCHEDULE_ID}/receipt?days=30`,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toMatchObject({
      scheduleId: SCHEDULE_ID,
      runs: 2,
      noChange: 1,
      useful: 1,
      neededHuman: 0,
      repeatedFailures: 1,
      skippedOverlap: 1,
      manualRuns: 1,
      cost: 1.5,
      costPerUsefulRun: 1.5,
    });

    const accepted = await app.inject({
      method: 'PUT',
      url: `/api/v1/system/schedules/${SCHEDULE_ID}/suggestion`,
      payload: { suggestion: 'slow_down', days: 30 },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ scheduleId: SCHEDULE_ID, suggestion: 'slow_down' });

    const relisted = await app.inject({ method: 'GET', url: '/api/v1/system/schedules' });
    const acceptedView = (
      relisted.json() as {
        schedules: Array<{ id: string; acceptedSuggestion: { suggestion: string } | null }>;
      }
    ).schedules.find((entry) => entry.id === SCHEDULE_ID);
    expect(acceptedView?.acceptedSuggestion?.suggestion).toBe('slow_down');
  });

  it('rejects an unknown schedule and an unknown suggestion', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/system/schedules/nope/receipt',
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/v1/system/schedules/${SCHEDULE_ID}/suggestion`,
      payload: { suggestion: 'delete_everything' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
