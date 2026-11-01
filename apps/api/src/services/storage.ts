/**
 * Storage sizing (Phase 23.3): Postgres by category, blobs, models, plugins
 * and optional logs. Read-only; the dashboard caches the result for 10 minutes.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Database } from '@triageai/kernel';
import type { DashboardStorage } from '@triageai/contracts';

const CATEGORY_TABLE: Record<string, string> = {
  kb_documents: 'knowledge',
  kb_sources: 'knowledge',
  kb_ingest_runs: 'knowledge',
  kb_ingest_items: 'knowledge',
  vector_chunks: 'knowledge',
  extracted_datasets: 'datasets',
  extracted_rows: 'datasets',
  extraction_mappings: 'datasets',
  extraction_rules: 'datasets',
  chat_conversations: 'chat',
  chat_messages: 'chat',
  workflow_runs: 'runs',
  stage_runs: 'runs',
  decision_records: 'runs',
  queue_jobs: 'runs',
  queue_deadletters: 'runs',
  model_call_traces: 'traces',
  audit_events: 'audit',
};

function categoryFor(schema: string, table: string): string {
  if (schema === 'mod_kb') return 'knowledge';
  if (schema === 'mod_data_extract') return 'datasets';
  if (schema === 'mod_chat') return 'chat';
  if (schema === 'mod_support') return 'support';
  return CATEGORY_TABLE[table] ?? 'other';
}

async function walkBytes(root: string | undefined): Promise<number> {
  if (!root) return 0;
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return info.size;
  } catch {
    return 0;
  }
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await walkBytes(path);
    else {
      try {
        total += (await stat(path)).size;
      } catch {
        // vanished while walking
      }
    }
  }
  return total;
}

let cache: { key: string; at: number; value: DashboardStorage } | null = null;

export async function readStorage(
  database: Database,
  options: { blobRoot?: string; pluginsRoot?: string; modelRoot?: string; logRoot?: string } = {},
): Promise<DashboardStorage> {
  const key = JSON.stringify(options);
  if (cache && cache.key === key && Date.now() - cache.at < 10 * 60 * 1000) return cache.value;
  const [databaseBytes, tables, blobBytes, modelBytes, pluginBytes, logBytes] = await Promise.all([
    database
      .query<{ bytes: string }>(`SELECT pg_database_size(current_database())::bigint AS bytes`)
      .then((rows) => Number(rows[0]?.bytes ?? 0))
      .catch(() => 0),
    database
      .query<{ schema: string; table: string; bytes: string }>(
        `SELECT schemaname AS schema, tablename AS table,
                pg_total_relation_size(format('%I.%I', schemaname, tablename))::bigint AS bytes
           FROM pg_tables
          WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
          ORDER BY bytes DESC`,
      )
      .catch(() => [] as Array<{ schema: string; table: string; bytes: string }>),
    walkBytes(options.blobRoot),
    walkBytes(options.modelRoot),
    walkBytes(options.pluginsRoot),
    walkBytes(options.logRoot),
  ]);

  const byCategory = new Map<string, number>();
  for (const row of tables) {
    const category = categoryFor(row.schema, row.table);
    byCategory.set(category, (byCategory.get(category) ?? 0) + Number(row.bytes));
  }
  if (blobBytes > 0) byCategory.set('knowledge', (byCategory.get('knowledge') ?? 0) + blobBytes);
  if (modelBytes > 0) byCategory.set('models', modelBytes);
  if (pluginBytes > 0) byCategory.set('plugins', pluginBytes);
  if (logBytes > 0) byCategory.set('logs', logBytes);

  const value: DashboardStorage = {
    totalBytes: databaseBytes + blobBytes + modelBytes + pluginBytes + logBytes,
    databaseBytes,
    blobBytes,
    modelBytes,
    pluginBytes,
    logBytes,
    byCategory: [...byCategory.entries()]
      .map(([category, bytes]) => ({ category, bytes }))
      .sort((a, b) => b.bytes - a.bytes),
  };
  cache = { key, at: Date.now(), value };
  return value;
}
