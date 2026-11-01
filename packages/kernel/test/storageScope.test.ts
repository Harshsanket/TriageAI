import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizePermissions } from '../src/grants.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import { dropModuleStorage, provisionModuleStorage } from '../src/storageScope.js';
import type { KernelLogger, TriageModule } from '../src/types.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const scopedModule: TriageModule = {
  id: 'scope-test',
  version: '0.0.1',
  capabilities: [],
  permissions: normalizePermissions({ storage: { schema: true } }),
  dependsOn: { capabilities: [] },
  migrations: [
    {
      id: '0001-scope-notes',
      sql: 'CREATE TABLE IF NOT EXISTS scope_notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);',
    },
  ],
  tables: ['scope_notes'],
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: {},
  register: () => undefined,
};

describeIfDb('schema-per-module storage (ADR-0054 §3)', () => {
  let database: PostgresDatabase;

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await dropModuleStorage(database, scopedModule).catch(() => undefined);
    await database.query(`DROP SCHEMA IF EXISTS mod_scope_test CASCADE`);
    await database.query(`DROP ROLE IF EXISTS mod_scope_test`).catch(() => undefined);
    await database
      .query(`DELETE FROM kernel_migrations WHERE module_id = 'scope-test'`)
      .catch(() => undefined);
  });

  afterAll(async () => {
    await dropModuleStorage(database, scopedModule).catch(() => undefined);
    await database.query(`DROP SCHEMA IF EXISTS mod_scope_test CASCADE`).catch(() => undefined);
    await database
      .query(`DELETE FROM kernel_migrations WHERE module_id = 'scope-test'`)
      .catch(() => undefined);
    await database.close();
  });

  it('moves tables into mod_<id> and enforces the role boundary', async () => {
    await provisionModuleStorage(database, scopedModule);
    const runner = new MigrationRunner(database, logger);
    const applied = await runner.apply('scope-test', scopedModule.migrations ?? [], {
      schema: 'mod_scope_test',
    });
    expect(applied.conflicts).toEqual([]);
    const storage = await provisionModuleStorage(database, scopedModule);
    expect(storage).not.toBeNull();

    await storage?.database.query(`INSERT INTO scope_notes (id, body) VALUES ($1, $2)`, [
      'n1',
      'hello',
    ]);
    const rows = await storage?.database.query(`SELECT body FROM scope_notes`);
    expect(rows).toEqual([{ body: 'hello' }]);

    await expect(
      storage?.database.query(`SELECT * FROM public.workflow_runs LIMIT 1`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      storage?.database.query(`SELECT * FROM mod_chat.chat_messages LIMIT 1`),
    ).rejects.toThrow(/permission denied|does not exist/i);
  });
});
