import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { DEFAULT_DATA_CLASSES } from '../src/data/classes.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { deleteExpiredRows, forgetSubject, planClassRetention } from '../src/retention/classes.js';
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

describe('class retention plan (phase 18.8)', () => {
  it('keeps held classes and deletes day-based classes', () => {
    const plan = planClassRetention(Object.values(DEFAULT_DATA_CLASSES), {
      legalHolds: ['audit_events'],
    });
    expect(plan.find((row) => row.classId === 'audit_events')).toMatchObject({
      action: 'legal_hold',
    });
    expect(plan.find((row) => row.classId === 'decision_records')).toMatchObject({
      action: 'delete',
      days: 180,
    });
    expect(plan.find((row) => row.classId === 'legal_holds')).toMatchObject({
      action: 'keep',
    });
  });
});

describeIfDb('class-driven retention + forget me (phase 18.8/18.T17)', () => {
  let database: PostgresDatabase;
  const suffix = ulid().toLowerCase();
  const subject = `forget-${suffix}@test.dev`;
  const userId = ulid();
  const runForUser = ulid();

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM workflow_runs WHERE id = $1`, [runForUser]);
    await database.query(`DELETE FROM candidate_examples WHERE actor = $1`, [subject]);
    await database.query(`DELETE FROM user_skills WHERE owner_id = $1`, [subject]);
    await database.query(`DELETE FROM user_preferences WHERE user_id = $1`, [userId]);
    await database.close();
  });

  it('deletes personal data from kernel classes and reports module-owned classes', async () => {
    await database.query(
      `INSERT INTO users (id, email, password_hash, name, role)
       VALUES ($1, $2, 'hash', 'Forget Me', 'customer')`,
      [userId, subject],
    );
    await database.query(`INSERT INTO user_preferences (user_id, preferences) VALUES ($1, '{}')`, [
      userId,
    ]);
    await database.query(
      `INSERT INTO user_skills (id, owner_id, name, description, content)
       VALUES ($1, $2, 'forget-skill', 'x', 'x')`,
      [ulid(), subject],
    );
    await database.query(
      `INSERT INTO candidate_examples (id, source, input, gold, provenance, status, actor)
       VALUES ($1, 'test', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'proposed', $2)`,
      [ulid(), subject],
    );
    await database.query(
      `INSERT INTO workflow_runs (id, workflow_id, workflow_version, trigger, status, input, owner_id)
       VALUES ($1, 'retention.test', '1', 'manual', 'SUCCEEDED', '{}'::jsonb, $2)`,
      [runForUser, subject],
    );
    const stageId = ulid();
    await database.query(
      `INSERT INTO stage_runs (id, run_id, stage_id, kind, status)
       VALUES ($1, $2, 'one', 'test', 'SUCCEEDED')`,
      [stageId, runForUser],
    );
    await database.query(
      `INSERT INTO decision_records
         (id, run_id, stage_run_id, workflow_id, workflow_version, module_id, module_version, evidence)
       VALUES ($1, $2, $3, 'retention.test', '1', 'kernel', '1', '{}'::jsonb)`,
      [ulid(), runForUser, stageId],
    );

    const result = await forgetSubject(database, subject);
    expect(result.deleted.users).toBe(1);
    expect(result.deleted.user_preferences).toBe(1);
    expect(result.deleted.user_skills).toBe(1);
    expect(result.deleted.candidate_examples).toBe(1);
    expect(result.deleted.workflow_runs).toBe(1);
    expect(result.skipped).toContainEqual({
      classId: 'support_tickets',
      reason: 'module-owned:support',
    });
    expect(result.skipped).toContainEqual({
      classId: 'audit_events',
      reason: 'append-only audit chain',
    });
    expect(await database.query(`SELECT 1 FROM users WHERE id = $1`, [userId])).toHaveLength(0);
    expect(
      await database.query(`SELECT 1 FROM stage_runs WHERE run_id = $1`, [runForUser]),
    ).toHaveLength(0);
    expect(
      await database.query(`SELECT 1 FROM decision_records WHERE run_id = $1`, [runForUser]),
    ).toHaveLength(0);
  }, 30_000);

  it('deletes expired rows only for mapped non-partitioned classes', async () => {
    const id = ulid();
    await database.query(
      `INSERT INTO queue_deadletters (id, queue, payload, attempts, error, created_at)
       VALUES ($1, 'test', '{}'::jsonb, 1, 'x', '2001-01-01T00:00:00Z')`,
      [id],
    );
    const deleted = await deleteExpiredRows(
      database,
      'queue_deadletters',
      new Date('2002-01-01T00:00:00Z'),
    );
    expect(deleted).toBeGreaterThanOrEqual(1);
  });
});
