import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

type App = FastifyInstance & { kernel?: Kernel };

describeIfDb('dead-letter replay (phase 10c)', () => {
  let app: App;
  const suffix = ulid().toLowerCase();
  const deadId = `dl-${suffix}`;
  const queue = `test-dlq-${suffix}`;
  const payload = { runId: `run-${suffix}` };
  const structured = {
    code: 'DEPENDENCY_UNAVAILABLE',
    category: 'dependency_unavailable' as const,
    retryable: true,
    message: 'dependency unavailable',
    attempt: 4,
  };
  const jobIds: string[] = [];

  beforeEach(async () => {
    app = (await buildApp({ quiet: true })) as App;
    const database = app.kernel!.database;
    await database.query(`DELETE FROM queue_deadletters WHERE id = $1`, [deadId]);
    await database.query(
      `INSERT INTO queue_deadletters (id, queue, payload, attempts, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [deadId, queue, payload, 4, JSON.stringify(structured)],
    );
  });

  afterEach(async () => {
    const database = app.kernel!.database;
    for (const id of jobIds) {
      await database.query(`DELETE FROM queue_jobs WHERE id = $1`, [id]);
    }
    jobIds.length = 0;
    await database.query(`DELETE FROM queue_deadletters WHERE id = $1`, [deadId]);
    await app.close();
  });

  it('lists the structured error and replays the job with an audit row', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/system/deadletters' });
    expect(list.statusCode).toBe(200);
    const items = list.json() as Array<{
      id: string;
      queue: string;
      payload: unknown;
      attempts: number;
      error: string;
      errorDetails: unknown;
    }>;
    expect(items.find((item) => item.id === deadId)).toMatchObject({
      queue,
      payload,
      attempts: 4,
      error: 'dependency unavailable',
      errorDetails: structured,
    });

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/system/deadletters/${deadId}/replay`,
    });
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json() as { id: string; replayed: boolean; jobId: string };
    expect(replayed).toMatchObject({ id: deadId, replayed: true });
    jobIds.push(replayed.jobId);

    const database = app.kernel!.database;
    const jobs = await database.query<{ queue: string; payload: unknown; status: string }>(
      `SELECT queue, payload, status FROM queue_jobs WHERE id = $1`,
      [replayed.jobId],
    );
    expect(jobs[0]).toMatchObject({ queue, payload, status: 'pending' });

    const dead = await database.query(`SELECT id FROM queue_deadletters WHERE id = $1`, [deadId]);
    expect(dead).toHaveLength(0);

    const audit = await database.query<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_events
        WHERE subject = $1 AND action = 'deadletter.replayed'`,
      [deadId],
    );
    expect(audit).toEqual([{ action: 'deadletter.replayed', actor: 'local@triageai.dev' }]);
  });

  it('discards a dead letter with an audit row', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/system/deadletters/${deadId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: deadId, discarded: true });

    const database = app.kernel!.database;
    const dead = await database.query(`SELECT id FROM queue_deadletters WHERE id = $1`, [deadId]);
    expect(dead).toHaveLength(0);
    const audit = await database.query<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_events
        WHERE subject = $1 AND action = 'deadletter.discarded'`,
      [deadId],
    );
    expect(audit).toEqual([{ action: 'deadletter.discarded', actor: 'local@triageai.dev' }]);
  });

  it('returns 404 for an unknown dead letter', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/system/deadletters/does-not-exist/replay',
    });
    expect(res.statusCode).toBe(404);
  });
});
