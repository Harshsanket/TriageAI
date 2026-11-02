import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

let app: App;
beforeEach(async () => {
  app = (await buildApp({
    quiet: true,
    configPath: resolve(process.cwd(), '../../triage.config.json'),
  })) as App;
});
afterEach(async () => {
  await app.close();
});

describeIfDb('live events (phase 18)', () => {
  it('delivers workflow run changes through LISTEN/NOTIFY', async () => {
    const runId = ulid();
    const payload = new Promise<string>((resolve) => {
      void app.kernel!.database.listen!('triageai_events', resolve).then(async (off) => {
        try {
          await app.kernel!.database.query(
            `INSERT INTO workflow_runs
               (id, workflow_id, workflow_version, trigger, status, input)
             VALUES ($1, 'echo.run', '0.1.0', 'manual', 'PENDING', '{}'::jsonb)`,
            [runId],
          );
        } finally {
          setTimeout(() => void off(), 250);
        }
      });
    });
    await expect(payload).resolves.toContain(runId);
  });

  it('streams a hello + activity snapshot and closes on once=1', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/system/events?once=1',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: hello');
    expect(res.body).toContain('event: activity');
    expect(res.body).toContain('activeRuns');
  });
});
