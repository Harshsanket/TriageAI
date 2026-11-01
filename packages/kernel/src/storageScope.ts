/**
 * Schema-per-module storage (ADR-0054 §3). The core owns the schema and role;
 * module SQL runs through a database bound to that role, so Postgres — not
 * application code — enforces the boundary.
 */
import { moduleSchemaName, quoteIdent } from './storage.js';
import type { Database, TriageModule, TxDatabase } from './types.js';

export interface ModuleStorage {
  schema: string;
  role: string;
  database: Database;
}

const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

export class RoleScopedDatabase implements Database {
  constructor(
    private readonly inner: Database,
    private readonly role: string,
    private readonly schema: string,
  ) {}

  private async bind(tx: TxDatabase): Promise<void> {
    await tx.query(`SET LOCAL ROLE ${quoteIdent(this.role)}`);
    await tx.query(`SET LOCAL search_path TO ${quoteIdent(this.schema)}`);
  }

  async query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<Array<T>> {
    return this.inner.transaction(async (tx) => {
      await this.bind(tx);
      return tx.query<T>(text, params);
    });
  }

  async transaction<T>(fn: (tx: TxDatabase) => Promise<T>): Promise<T> {
    return this.inner.transaction(async (tx) => {
      await this.bind(tx);
      return fn(tx);
    });
  }
}

/**
 * Create/refresh `mod_<id>` + its role, move legacy public tables into it and
 * return a database bound to that role. Idempotent; safe to run on every boot.
 */
export async function provisionModuleStorage(
  database: Database,
  module: TriageModule,
): Promise<ModuleStorage | null> {
  if (!module.permissions?.storage?.schema) return null;
  const schema = moduleSchemaName(module.id);
  if (!SAFE_IDENT.test(schema)) throw new Error(`unsafe module schema: ${schema}`);
  const role = schema;

  await database.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
  await database.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
        CREATE ROLE ${quoteIdent(role)} NOLOGIN;
      END IF;
    END $$;
  `);
  // The kernel connection must be able to SET ROLE on behalf of the module.
  await database.query(`GRANT ${quoteIdent(role)} TO CURRENT_USER`).catch(() => undefined);

  // Existing installs have their tables in `public`; move them once. Fresh
  // installs create tables in the schema directly (the migration runner sets
  // search_path to `mod_<id>, public` while applying them).
  for (const table of module.tables ?? []) {
    if (!SAFE_IDENT.test(table)) continue;
    await database.query(`
      DO $$
      BEGIN
        IF to_regclass('public.${table}') IS NOT NULL
           AND to_regclass('${schema}.${table}') IS NULL THEN
          ALTER TABLE public.${table} SET SCHEMA ${quoteIdent(schema)};
        END IF;
      END $$;
    `);
  }

  await database.query(`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)}`);
  await database.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdent(
      schema,
    )} TO ${quoteIdent(role)}`,
  );
  await database.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)}`,
  );
  await database.query(`ALTER ROLE ${quoteIdent(role)} SET search_path TO ${quoteIdent(schema)}`);
  await database.query(`ALTER ROLE ${quoteIdent(role)} SET statement_timeout = '30s'`);

  return {
    schema,
    role,
    database: new RoleScopedDatabase(database, role, schema),
  };
}

/** Explicit uninstall: drop the module's schema and role (ADR-0054 §3). */
export async function dropModuleStorage(
  database: Database,
  module: TriageModule,
): Promise<string[]> {
  if (!module.permissions?.storage?.schema) return [];
  const schema = moduleSchemaName(module.id);
  if (!SAFE_IDENT.test(schema)) return [];
  await database.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  await database.query(`DROP ROLE IF EXISTS ${quoteIdent(schema)}`).catch(() => undefined);
  return [schema];
}
