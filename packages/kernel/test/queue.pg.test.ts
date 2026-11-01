import { describe } from 'vitest';

import { CORE_MIGRATIONS } from '../src/migrations.js';
import { PgQueue } from '../src/queue/pg.js';
import { queueContractSuite } from '../src/queue/contract.js';
import { MIGRATIONS_TABLE_SQL, MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type { KernelLogger } from '../src/types.js';

const noopLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('pg-queue adapter', () => {
  queueContractSuite('pg-queue', async () => {
    const database = new PostgresDatabase(DATABASE_URL);
    await database.query(MIGRATIONS_TABLE_SQL);
    const runner = new MigrationRunner(database, noopLogger);
    await runner.apply('kernel', CORE_MIGRATIONS);
    // Isolation: the queue tables persist between runs; clear leftovers so
    // dedupe/DLQ counts are deterministic.
    await database.query(`DELETE FROM queue_jobs`);
    await database.query(`DELETE FROM queue_deadletters`);
    const queue = new PgQueue(database, noopLogger);
    return {
      queue,
      dispose: async () => {
        await queue.drain();
        await database.close();
      },
    };
  });
});

import { expect, it } from 'vitest';

describeIfDb('pg-queue stuck leases (phase 21)', () => {
  it('dead-letters a crashed job once it has used all attempts', async () => {
    const database = new PostgresDatabase(DATABASE_URL);
    await database.query(MIGRATIONS_TABLE_SQL);
    await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
    await database.query(`DELETE FROM queue_jobs WHERE queue = 't.lease'`);
    await database.query(`DELETE FROM queue_deadletters WHERE queue = 't.lease'`);
    await database.query(
      `INSERT INTO queue_jobs (id, queue, payload, status, attempts, max_attempts, ready_at, lease_expires_at)
       VALUES ('lease-crash-1', 't.lease', '{"n":1}', 'processing', 4, 4, now(), now() - interval '1 minute')`,
    );
    const queue = new PgQueue(database, noopLogger);
    const subscription = queue.subscribe('t.lease', async () => undefined, {
      pollIntervalMs: 50,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await subscription.stop();
    const jobs = await database.query<{ id: string }>(
      `SELECT id FROM queue_jobs WHERE id = 'lease-crash-1'`,
    );
    const dead = await database.query<{ id: string; attempts: number }>(
      `SELECT id, attempts FROM queue_deadletters WHERE id = 'lease-crash-1'`,
    );
    expect(jobs).toHaveLength(0);
    expect(dead[0]?.attempts).toBe(4);
    await database.query(`DELETE FROM queue_deadletters WHERE queue = 't.lease'`);
    await database.close();
  });
});
