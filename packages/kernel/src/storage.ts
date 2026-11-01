/**
 * Storage capability: a thin, vendor-shown Database interface (ADR-0009).
 * The host injects the concrete driver. Migrations are checksummed and
 * recorded per module — uninstall drops them only via an explicit command.
 */
import { createHash } from 'node:crypto';

import postgres from 'postgres';

import type { Database, Migration, TxDatabase } from './types.js';

/** Identifiers are code constants, but never interpolate unchecked text. */
export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}

const CORE_TABLES = new Set([
  'orgs',
  'workflow_runs',
  'stage_runs',
  'decision_records',
  'candidate_examples',
  'datasets',
  'model_assets',
  'eval_reports',
  'settings',
  'audit_events',
  'queue_jobs',
  'queue_deadletters',
  'vector_chunks',
  'users',
  'auth_sessions',
  'config_overlays',
  'secrets',
  'setup_imports',
  'plugin_installs',
  'cost_ledger',
  'shared_state',
  'state_events',
  'work_items',
  'workspace_decisions',
  'memories',
  'model_call_traces',
  'outbox_events',
  'approvals',
  'agent_definitions',
  'agent_steps',
  'agent_checkpoints',
  'job_progress',
  'user_preferences',
  'module_grants',
  'kernel_migrations',
]);

/**
 * Applied before the schema split shipped (ADR-0054 §3); the checksummed SQL
 * stays untouched, and a later migration drops its core foreign keys.
 */
const LEGACY_MIGRATIONS = new Set(['echo:0001-echo-notes']);

export interface MigrationLintFinding {
  rule: string;
  detail: string;
}

/** Refuse module SQL that reaches outside its own schema (ADR-0054 §3). */
export function lintModuleMigration(
  moduleId: string,
  migration: Migration,
): MigrationLintFinding[] {
  if (LEGACY_MIGRATIONS.has(`${moduleId}:${migration.id}`)) return [];
  const findings: MigrationLintFinding[] = [];
  const add = (rule: string, detail: string) => findings.push({ rule, detail });
  if (/\bGRANT\b/i.test(migration.sql)) add('grant', 'module migrations may not GRANT');
  if (/\bCREATE\s+ROLE\b/i.test(migration.sql))
    add('role', 'module migrations may not CREATE ROLE');
  if (/\bCREATE\s+EXTENSION\b/i.test(migration.sql))
    add('extension', 'module migrations may not CREATE EXTENSION');
  if (/\bpublic\s*\./i.test(migration.sql))
    add('core-schema', 'module migrations may not name public.*');
  for (const match of migration.sql.matchAll(/\bREFERENCES\s+([a-z_][a-z0-9_]*)/gi)) {
    const table = (match[1] ?? '').toLowerCase();
    if (CORE_TABLES.has(table)) add('core-fk', `foreign key to core table ${table}`);
  }
  return findings;
}

export function moduleSchemaName(moduleId: string): string {
  return `mod_${moduleId.replace(/[^a-z0-9_]/g, '_')}`;
}

export class PostgresDatabase implements Database {
  private sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 10, idle_timeout: 20, connect_timeout: 10 });
  }

  async query<T extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<Array<T>> {
    const result = await this.sql.unsafe<T[]>(text, (params ?? []) as never[]);
    return result as Array<T>;
  }

  async transaction<T>(fn: (tx: TxDatabase) => Promise<T>): Promise<T> {
    const promise = this.sql.begin(async (tx) =>
      fn({
        query: async <R extends Record<string, unknown>>(
          text: string,
          params?: unknown[],
        ): Promise<R[]> => (await tx.unsafe<R[]>(text, (params as never[]) ?? [])) as R[],
      }),
    );
    return promise as Promise<T>;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

export function checksumSql(sqlText: string): string {
  return createHash('sha256').update(sqlText).digest('hex').slice(0, 16);
}

export const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS kernel_migrations (
  module_id   TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (module_id, migration_id)
);
`;

export interface MigrationResult {
  applied: Array<{ moduleId: string; id: string }>;
  conflicts: Array<{ moduleId: string; id: string; reason: string }>;
  alreadyApplied: Array<{ moduleId: string; id: string }>;
}

export class MigrationRunner {
  constructor(
    private database: Database,
    private logger: { info(u: unknown, m?: string): void },
  ) {}

  async apply(
    moduleId: string,
    migrations: Migration[],
    options: { schema?: string } = {},
  ): Promise<MigrationResult> {
    // Tests and tools may reach the runner before a kernel boot has created the
    // ledger; `IF NOT EXISTS` keeps this idempotent for every caller.
    await this.database.query(MIGRATIONS_TABLE_SQL);
    const result: MigrationResult = { applied: [], conflicts: [], alreadyApplied: [] };
    for (const migration of migrations) {
      const checksum = checksumSql(migration.sql);
      // Advisory lock per migration serializes concurrent boots (parallel test
      // processes, duplicate api instances) racing on CREATE TABLE IF NOT EXISTS.
      await this.database.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `kernel:migration:${moduleId}:${migration.id}`,
        ]);
        if (options.schema) {
          await tx.query(`SET LOCAL search_path TO ${quoteIdent(options.schema)}, public`);
        }
        const rows = await tx.query<{ checksum: string }>(
          `SELECT checksum FROM kernel_migrations WHERE module_id = $1 AND migration_id = $2`,
          [moduleId, migration.id],
        );
        const existing = rows[0];
        if (existing) {
          if (existing.checksum !== checksum) {
            result.conflicts.push({
              moduleId,
              id: migration.id,
              reason: `checksum changed since it was applied (${existing.checksum} → ${checksum})`,
            });
            return;
          }
          result.alreadyApplied.push({ moduleId, id: migration.id });
          return;
        }
        await tx.query(migration.sql);
        await tx.query(
          `INSERT INTO kernel_migrations (module_id, migration_id, checksum) VALUES ($1, $2, $3)`,
          [moduleId, migration.id, checksum],
        );
        result.applied.push({ moduleId, id: migration.id });
      });
      if (result.applied.some((a) => a.moduleId === moduleId && a.id === migration.id)) {
        this.logger.info({ module: moduleId, migration: migration.id }, 'migration applied');
      }
    }
    return result;
  }

  /** Explicit uninstall only (ADR-0001). Returns the ids whose dropSql ran. */
  async uninstall(moduleId: string, migrations: Migration[]): Promise<string[]> {
    const dropped: string[] = [];
    for (const migration of [...migrations].reverse()) {
      if (!migration.dropSql) continue;
      await this.database.query(migration.dropSql);
      dropped.push(migration.id);
    }
    await this.database.query(`DELETE FROM kernel_migrations WHERE module_id = $1`, [moduleId]);
    return [...new Set([...dropped])];
  }
}
