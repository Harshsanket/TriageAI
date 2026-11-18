import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { bootKernel, type Kernel } from '../src/kernel.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { dropExpiredPartitions, ensureMonthPartitions } from '../src/retention/partitions.js';
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

const PARTITIONED = [
  'decision_records',
  'stage_runs',
  'audit_events',
  'state_events',
  'cost_ledger',
  'outbox_events',
  'app_boots',
];

describeIfDb('partition retention (phase 18.10)', () => {
  let database: PostgresDatabase;
  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
    // Other suites may have written backdated boot rows into the default
    // partition; clear this range so the fixture partition can be attached.
    await database.query(`DELETE FROM app_boots WHERE at >= '2020-01-01' AND at < '2020-02-01'`);
    await database.query(
      `CREATE TABLE IF NOT EXISTS app_boots_2020_01
       PARTITION OF app_boots FOR VALUES FROM ('2020-01-01') TO ('2020-02-01')`,
    );
  });
  afterAll(async () => {
    await database.close();
  });

  it('month-partitions every append-only table', async () => {
    const rows = await database.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'p' AND c.relname = ANY($1::text[])`,
      [PARTITIONED],
    );
    expect(rows.map((row) => row.relname).sort()).toEqual([...PARTITIONED].sort());
  });

  it('drops old month partitions and counts their rows', async () => {
    await database.query(
      `CREATE TABLE IF NOT EXISTS app_boots_2000_01
       PARTITION OF app_boots FOR VALUES FROM ('2000-01-01') TO ('2000-02-01')`,
    );
    await database.query(`INSERT INTO app_boots (at) VALUES ('2000-01-15T00:00:00Z')`);
    const dropped = await dropExpiredPartitions(
      database,
      'app_boots',
      new Date('2001-01-01T00:00:00Z'),
    );
    const target = dropped.find((entry) => entry.partition === 'app_boots_2000_01');
    expect(target?.rows).toBe(1);
    const rows = await database.query(`SELECT 1 FROM pg_class WHERE relname = 'app_boots_2000_01'`);
    expect(rows).toHaveLength(0);
  });

  it('keeps upcoming partitions idempotently', async () => {
    const first = await ensureMonthPartitions(database, 'state_events');
    const second = await ensureMonthPartitions(database, 'state_events');
    expect(Array.isArray(first)).toBe(true);
    expect(second).toEqual([]);
  });

  it('moves rows out of the default partition before creating their month', async () => {
    const at = new Date('2035-06-15T12:00:00Z');
    // Re-runs must start from the default partition, not a leftover month.
    await database.query(`DROP TABLE IF EXISTS app_boots_2035_06`);
    await database.query(`INSERT INTO app_boots (at) VALUES ($1)`, [at]);
    const before = await database.query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM app_boots WHERE at = $1`,
      [at],
    );
    expect(before[0]?.part).toBe('app_boots_default');
    await ensureMonthPartitions(
      database,
      'app_boots',
      new Date('2035-06-01T00:00:00Z'),
      0,
      0,
      'at',
    );
    const after = await database.query<{ part: string }>(
      `SELECT tableoid::regclass::text AS part FROM app_boots WHERE at = $1`,
      [at],
    );
    expect(after[0]?.part).toBe('app_boots_2035_06');
  });

  it('wires partition drops into runRetention', async () => {
    const kernel: Kernel = await bootKernel({
      config: {
        profile: 'core',
        queue: { adapter: 'inline' },
        modules: {},
        capabilities: {},
        retention: {
          enabled: true,
          intervalHours: 24,
          runDays: null,
          decisionDays: 30,
          auditDays: null,
          candidateDays: null,
          messageDays: null,
          deadletterDays: null,
        },
      },
      database,
      logger,
      modules: {},
    });
    const runId = ulid();
    try {
      await database.query(
        `CREATE TABLE IF NOT EXISTS outbox_events_1999_01
         PARTITION OF outbox_events FOR VALUES FROM ('1999-01-01') TO ('1999-02-01')`,
      );
      await database.query(
        `INSERT INTO outbox_events (id, topic, payload, created_at)
         VALUES ($1, 'test', '{}'::jsonb, '1999-01-15T00:00:00Z')`,
        [ulid()],
      );
      const report = (await kernel.runRetention(new Date())) as unknown as {
        droppedPartitions: Array<{ partition: string }>;
        results: Array<{ id: string; deleted: number }>;
      };
      expect(report.results.some((row) => row.id === 'kernel.outbox_events')).toBe(true);
      expect(
        await database.query(`SELECT 1 FROM pg_class WHERE relname = 'outbox_events_1999_01'`),
      ).toHaveLength(0);
    } finally {
      await database.query(`DROP TABLE IF EXISTS outbox_events_1999_01`);
      await database.query(`DELETE FROM workflow_runs WHERE id = $1`, [runId]);
      await kernel.shutdown();
    }
  }, 30_000);

  it('honours a legal hold and drops the partition after release', async () => {
    const kernel: Kernel = await bootKernel({
      config: {
        profile: 'core',
        queue: { adapter: 'inline' },
        modules: {},
        capabilities: {},
        retention: {
          enabled: true,
          intervalHours: 24,
          runDays: null,
          decisionDays: null,
          auditDays: null,
          candidateDays: null,
          messageDays: null,
          deadletterDays: null,
        },
      },
      database,
      logger,
      modules: {},
    });
    try {
      await database.query(
        `INSERT INTO legal_holds (id, class_id, reason, created_by)
         VALUES ($1, 'state_events', 'litigation', 'test')`,
        [ulid()],
      );
      await database.query(
        `CREATE TABLE IF NOT EXISTS state_events_2001_01
         PARTITION OF state_events FOR VALUES FROM ('2001-01-01') TO ('2001-02-01')`,
      );
      await database.query(
        `INSERT INTO state_events (id, scope_type, scope_id, key, version, value, at)
         VALUES ($1, 'test', 'hold', 'k', 1, '{}'::jsonb, '2001-01-15T00:00:00Z')`,
        [ulid()],
      );
      const held = (await kernel.runRetention(new Date())) as unknown as {
        heldClasses: string[];
        droppedPartitions: Array<{ partition: string }>;
      };
      expect(held.heldClasses).toContain('state_events');
      expect(held.droppedPartitions.map((row) => row.partition)).not.toContain(
        'state_events_2001_01',
      );
      expect(
        await database.query(`SELECT 1 FROM pg_class WHERE relname = 'state_events_2001_01'`),
      ).toHaveLength(1);

      await database.query(`DELETE FROM legal_holds WHERE class_id = 'state_events'`);
      await kernel.runRetention(new Date());
      expect(
        await database.query(`SELECT 1 FROM pg_class WHERE relname = 'state_events_2001_01'`),
      ).toHaveLength(0);
    } finally {
      await database.query(`DELETE FROM legal_holds WHERE class_id = 'state_events'`);
      await database.query(`DROP TABLE IF EXISTS state_events_2001_01`);
      await kernel.shutdown();
    }
  }, 30_000);
});
