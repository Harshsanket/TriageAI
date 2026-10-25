import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

type App = FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };

describeIfDb('retention pass (phase 9)', () => {
  let app: App;
  let directory: string;
  const oldRun = ulid();
  const recentRun = ulid();
  const oldDecision = ulid();
  const oldAudit = ulid();
  const oldCandidate = ulid();
  const oldDeadletter = ulid();
  const ticketId = ulid();
  const oldMessage = ulid();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'triageai-retention-'));
    const configPath = join(directory, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'support',
        modules: {
          support: { enabled: true },
          'ai-pipeline': { enabled: true },
          chat: { enabled: false },
          echo: { enabled: false },
        },
        retention: {
          enabled: true,
          intervalHours: 24,
          runDays: 30,
          decisionDays: 30,
          auditDays: 30,
          candidateDays: 30,
          messageDays: 30,
          deadletterDays: 30,
        },
      }),
    );
    app = (await buildApp({
      quiet: true,
      authMode: 'disabled',
      rateLimit: { max: 0 },
      configPath,
    })) as App;

    const db = app.kernel!.database;
    await db.query(
      `INSERT INTO workflow_runs (id, workflow_id, workflow_version, trigger, status, input, finished_at, created_at)
       VALUES ($1, 'echo.run', '0.1.0', 'manual', 'SUCCEEDED', '{}'::jsonb, now() - interval '61 days', now() - interval '61 days')`,
      [oldRun],
    );
    await db.query(
      `INSERT INTO workflow_runs (id, workflow_id, workflow_version, trigger, status, input, finished_at, created_at)
       VALUES ($1, 'echo.run', '0.1.0', 'manual', 'SUCCEEDED', '{}'::jsonb, now(), now())`,
      [recentRun],
    );
    await db.query(
      `INSERT INTO decision_records
         (id, run_id, workflow_id, workflow_version, module_id, module_version, evidence, created_at)
       VALUES ($1, $2, 'echo.run', '0.1.0', 'echo', '0.1.0', '{"kind":"deterministic"}'::jsonb, now() - interval '61 days')`,
      [oldDecision, recentRun],
    );
    await db.query(
      `INSERT INTO audit_events (id, actor, action, payload, created_at)
       VALUES ($1, 'test', 'retention.fixture', '{}'::jsonb, now() - interval '61 days')`,
      [oldAudit],
    );
    await db.query(
      `INSERT INTO candidate_examples (id, source, input, gold, provenance, status, created_at)
       VALUES ($1, 'test', '{"text":"old"}'::jsonb, '{"category":"billing"}'::jsonb, '{}'::jsonb, 'proposed', now() - interval '61 days')`,
      [oldCandidate],
    );
    await db.query(
      `INSERT INTO queue_deadletters (id, queue, payload, attempts, error, created_at)
       VALUES ($1, 'workflow.run', '{}'::jsonb, 4, 'failed', now() - interval '61 days')`,
      [oldDeadletter],
    );
    await db.query(
      `INSERT INTO support_tickets (id, subject, body, requester, status)
       VALUES ($1, 'retention', 'old message body', 'tester', 'NEW')`,
      [ticketId],
    );
    await db.query(
      `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, created_at)
       VALUES ($1, $2, 'customer', 'tester', 'old message body', now() - interval '61 days')`,
      [oldMessage, ticketId],
    );
  });

  afterAll(async () => {
    const db = app.kernel?.database;
    if (db) {
      await db.query(`DELETE FROM support_tickets WHERE id = $1`, [ticketId]);
      await db.query(`DELETE FROM workflow_runs WHERE id = ANY($1::text[])`, [[oldRun, recentRun]]);
    }
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('deletes only rows older than the configured windows', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/system/retention/run',
    });
    expect(res.statusCode).toBe(200);
    const report = res.json() as {
      enabled: boolean;
      results: Array<{ id: string; deleted: number }>;
    };
    expect(report.enabled).toBe(true);
    const deleted = Object.fromEntries(report.results.map((r) => [r.id, r.deleted]));
    expect(deleted['kernel.workflow_runs']).toBe(1);
    expect(deleted['kernel.decision_records']).toBe(1);
    expect(deleted['kernel.audit_events']).toBeGreaterThanOrEqual(1);
    expect(deleted['kernel.candidate_examples']).toBe(1);
    expect(deleted['kernel.queue_deadletters']).toBe(1);
    expect(deleted['support.messages']).toBe(1);

    const db = app.kernel!.database;
    const runs = (await db.query(`SELECT id FROM workflow_runs WHERE id = ANY($1::text[])`, [
      [oldRun, recentRun],
    ])) as Array<{ id: string }>;
    expect(runs.map((r) => r.id)).toEqual([recentRun]);
    const messages = (await db.query(
      `SELECT id FROM support_ticket_messages WHERE ticket_id = $1`,
      [ticketId],
    )) as Array<{ id: string }>;
    expect(messages).toEqual([]);
  });

  it('exposes the configured windows to admins', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/retention' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, runDays: 30, messageDays: 30 });
  });
});
