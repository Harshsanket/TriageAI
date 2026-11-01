import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresDatabase } from '@triageai/kernel';

import { applyUpdate, compareVersions, currentVersion } from '../src/services/update.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

describe('update version comparison (phase 23.8)', () => {
  it('orders semantic versions and ignores a leading v', () => {
    expect(compareVersions('v1.2.0', '1.1.9')).toBe(1);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  it('reads the repository version', () => {
    expect(currentVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describeIfDb('update apply (phase 23.8)', () => {
  let database: PostgresDatabase;

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await database.query(`DELETE FROM settings WHERE key = 'updates.state'`);
    await database.query(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES ('updates.state', $1, 'test', now())`,
      [
        {
          version: 1,
          checkedAt: new Date().toISOString(),
          latestVersion: '9.9.9',
          available: true,
          stagedPath: '/tmp/triageai-update.tar.gz',
          releaseUrl: null,
          downloadUrl: null,
          notes: null,
          currentVersion: currentVersion(),
          canApply: true,
          error: null,
        },
      ],
    );
    process.env.TRIAGEAI_UPDATE_COMMAND = 'printf update-command-ran';
  });

  afterAll(async () => {
    delete process.env.TRIAGEAI_UPDATE_COMMAND;
    await database.query(`DELETE FROM settings WHERE key = 'updates.state'`);
    await database.close();
  });

  it('runs the operator-configured update command and audits it', async () => {
    const kernel = { database } as unknown as Parameters<typeof applyUpdate>[0];
    const result = await applyUpdate(kernel);
    expect(result).toMatchObject({ applied: true, canApply: true });
    const rows = await database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'update.applied' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]?.action).toBe('update.applied');
  });
});
