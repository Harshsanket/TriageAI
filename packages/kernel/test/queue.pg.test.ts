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
