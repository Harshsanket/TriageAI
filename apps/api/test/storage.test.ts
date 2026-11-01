import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresDatabase } from '@triageai/kernel';

import { readStorage } from '../src/services/storage.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

describeIfDb('storage sizing (phase 23.3)', () => {
  let database: PostgresDatabase;

  beforeAll(() => {
    database = new PostgresDatabase(DATABASE_URL);
  });
  afterAll(async () => {
    await database.close();
  });

  it('reports the database total within 1% of pg_database_size', async () => {
    const storage = await readStorage(database, {});
    const [databaseRows, tableRows] = await Promise.all([
      database.query<{ bytes: string }>(
        `SELECT pg_database_size(current_database())::bigint AS bytes`,
      ),
      database.query<{ bytes: string }>(
        `SELECT COALESCE(SUM(pg_total_relation_size(format('%I.%I', schemaname, tablename))), 0)::bigint AS bytes
           FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')`,
      ),
    ]);
    expect(storage.databaseBytes).toBe(Number(databaseRows[0]?.bytes ?? 0));
    expect(storage.byCategory.length).toBeGreaterThan(0);
    const categoryTotal = storage.byCategory.reduce((sum, entry) => sum + entry.bytes, 0);
    const tableTotal = Number(tableRows[0]?.bytes ?? 0);
    expect(categoryTotal).toBeGreaterThan(0);
    expect(Math.abs(categoryTotal - tableTotal)).toBeLessThanOrEqual(tableTotal * 0.01);
  });
});
