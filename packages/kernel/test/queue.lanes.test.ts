import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CORE_MIGRATIONS } from '../src/migrations.js';
import { PgQueue } from '../src/queue/pg.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type { KernelLogger } from '../src/types.js';

const noopLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describeIfDb('pg-queue priority lanes + backpressure (18.T4)', () => {
  let database: PostgresDatabase;
  let queue: PgQueue;

  beforeEach(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
    await database.query(`DELETE FROM queue_jobs WHERE queue = 't.lanes'`);
    await database.query(`DELETE FROM queue_deadletters WHERE queue = 't.lanes'`);
    queue = new PgQueue(database, noopLogger);
  });

  afterEach(async () => {
    await queue.close();
    await database.query(`DELETE FROM queue_jobs WHERE queue = 't.lanes'`);
    await database.close();
  });

  it('serves interactive (priority 1) before background (priority 0)', async () => {
    await queue.enqueue('t.lanes', { lane: 'background' }, { priority: 0 });
    await queue.enqueue('t.lanes', { lane: 'interactive' }, { priority: 1 });
    const order: string[] = [];
    const subscription = queue.subscribe(
      't.lanes',
      async (payload) => {
        order.push((payload as { lane: string }).lane);
      },
      { pollIntervalMs: 20 },
    );
    await tick(300);
    await subscription.stop();
    expect(order).toEqual(['interactive', 'background']);
  });

  it('defers background work while interactive work is pending', async () => {
    const seen: string[] = [];
    await queue.enqueue('t.lanes', { lane: 'background' }, { priority: 0 });
    for (let index = 0; index < 40; index += 1) {
      await queue.enqueue('t.lanes', { lane: `interactive-${index}` }, { priority: 1 });
    }
    const subscription = queue.subscribe(
      't.lanes',
      async (payload) => {
        seen.push((payload as { lane: string }).lane);
      },
      { pollIntervalMs: 20, backgroundDeferThreshold: 1 },
    );
    await tick(200);
    // Interactive work is still pending, so the older background job waits.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('background');
    await subscription.stop();
  });
});
