import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORE_MIGRATIONS } from '../src/migrations.js';
import { SharedStateStore } from '../src/state/index.js';
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
const SCOPE_A = `state-export-a-${Date.now()}`;
const SCOPE_B = `state-export-b-${Date.now()}`;

describeIfDb('shared state export/import (18.T3)', () => {
  let database: PostgresDatabase;
  let store: SharedStateStore;

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
    store = new SharedStateStore(database);
    await store.set({ scopeType: 'workspace', scopeId: SCOPE_A, key: 'plan', value: { step: 1 } });
    await store.set({
      scopeType: 'workspace',
      scopeId: SCOPE_A,
      key: 'secret',
      value: 'token',
      sensitivity: 'secret',
    });
  });

  afterAll(async () => {
    await database.query(`DELETE FROM state_events WHERE scope_id IN ($1, $2)`, [SCOPE_A, SCOPE_B]);
    await database.query(`DELETE FROM shared_state WHERE scope_id IN ($1, $2)`, [SCOPE_A, SCOPE_B]);
    await database.close();
  });

  it('exports and merges a scope without loosening sensitivity', async () => {
    const exported = await store.exportScope('workspace', SCOPE_A);
    expect(exported.entries).toHaveLength(2);
    expect(exported.entries.find((entry) => entry.key === 'secret')?.value).toBe(
      '[secret withheld]',
    );
    const result = await store.importScope({ ...exported, scopeId: SCOPE_B }, { mode: 'merge' });
    expect(result).toMatchObject({ imported: 2, removed: 0 });
    expect((await store.get('workspace', SCOPE_B, 'plan'))?.value).toEqual({ step: 1 });
    expect((await store.get('workspace', SCOPE_B, 'secret'))?.sensitivity).toBe('secret');
    // A later import cannot loosen an existing secret.
    await store.importScope(
      {
        ...exported,
        scopeId: SCOPE_B,
        entries: exported.entries.map((entry) => ({ ...entry, sensitivity: 'public' })),
      },
      { mode: 'merge' },
    );
    expect((await store.get('workspace', SCOPE_B, 'secret'))?.sensitivity).toBe('secret');
  });

  it('replace removes keys absent from the payload', async () => {
    await store.set({ scopeType: 'workspace', scopeId: SCOPE_B, key: 'extra', value: true });
    const exported = await store.exportScope('workspace', SCOPE_A);
    const result = await store.importScope(
      {
        ...exported,
        scopeId: SCOPE_B,
        entries: exported.entries.filter((entry) => entry.key === 'plan'),
      },
      { mode: 'replace' },
    );
    expect(result.removed).toBeGreaterThanOrEqual(2);
    expect(await store.get('workspace', SCOPE_B, 'extra')).toBeNull();
    expect(await store.get('workspace', SCOPE_B, 'secret')).toBeNull();
  });
});
