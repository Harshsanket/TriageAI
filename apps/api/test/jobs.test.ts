import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };
const ACTIVE = 'job-test-active';
const FINISHED = 'job-test-finished';

let app: App;
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'triageai-jobs-'));
  const configPath = path.join(dir, 'triage.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      profile: 'core',
      queue: { adapter: 'pg-queue', pollIntervalMs: 250 },
      modules: { echo: { enabled: true } },
      capabilities: {},
    }),
  );
  app = (await buildApp({
    quiet: true,
    configPath,
    setup: false,
    authMode: 'disabled',
  })) as App;
  await app.kernel?.database.query(`DELETE FROM job_progress WHERE job_id IN ($1, $2)`, [
    ACTIVE,
    FINISHED,
  ]);
  await app.kernel?.database.query(
    `INSERT INTO job_progress (job_id, run_id, workflow_id, owner_id, title, stage, done, total, unit, status)
     VALUES ($1, NULL, 'test.job', 'admin', 'Importing 2 files', 'embedding', 1, 2, 'files', 'running'),
            ($2, NULL, 'test.job', 'admin', 'Finished import', 'done', 2, 2, 'files', 'succeeded')`,
    [ACTIVE, FINISHED],
  );
});

afterEach(async () => {
  await app.kernel?.database.query(`DELETE FROM job_progress WHERE job_id IN ($1, $2)`, [
    ACTIVE,
    FINISHED,
  ]);
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describeIfDb('jobs tray API (phase 20.1)', () => {
  it('returns active and recent jobs, and streams a snapshot', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/jobs' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      active: Array<{ id: string; title: string }>;
      recent: Array<{ id: string; title: string }>;
    };
    expect(body.active.map((job) => job.id)).toContain(ACTIVE);
    expect(body.recent.map((job) => job.id)).toContain(FINISHED);

    const stream = await app.inject({ method: 'GET', url: '/api/v1/system/jobs/stream?once=1' });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('event: jobs');
    expect(stream.body).toContain(ACTIVE);
  });

  it('cancels an active job and refuses to cancel a finished one', async () => {
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/system/jobs/${ACTIVE}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    const rows = await app.kernel?.database.query<{ status: string }>(
      `SELECT status FROM job_progress WHERE job_id = $1`,
      [ACTIVE],
    );
    expect(rows?.[0]?.status).toBe('cancelled');

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/system/jobs/${FINISHED}/cancel`,
    });
    expect(conflict.statusCode).toBe(409);
  });
});
