import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORE_MIGRATIONS } from '../src/migrations.js';
import { dropExpiredPartitions } from '../src/retention/partitions.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type { KernelLogger } from '../src/types.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describeIfDb('partition retention (phase 18.10)', () => {
  let database: PostgresDatabase;
  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
    await database.query(
      `CREATE TABLE IF NOT EXISTS model_call_traces_2020_01
       PARTITION OF model_call_traces FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`,
    );
  });
  afterAll(async () => {
    await database.close();
  });

  it('drops old month partitions instead of deleting rows', async () => {
    const dropped = await dropExpiredPartitions(
      database,
      'model_call_traces',
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(dropped.map((entry) => entry.partition)).toContain('model_call_traces_2020_01');
    const rows = await database.query(
      `SELECT 1 FROM pg_class WHERE relname = 'model_call_traces_2020_01'`,
    );
    expect(rows).toHaveLength(0);
  });
});
