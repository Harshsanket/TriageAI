/**
 * Core read/write APIs exposed through `KernelContext` (ADR-0054 §3):
 * modules reach kernel-owned data through these functions, never raw SQL.
 */
import { ulid } from 'ulid';
import { RunDtoSchema, StageRunDtoSchema } from '@triageai/contracts';

import { auditHash } from './audit.js';
import { createSkillReadApi } from './skills/store.js';
import type {
  AuditAppendInput,
  CostLedgerEntry,
  Database,
  FeedbackProposal,
  KnowledgeReadApi,
  KernelContext,
  ModelTraceRecord,
  RunReadApi,
  RunReadFilter,
  RunWithStages,
} from './types.js';

interface RunRow {
  [key: string]: unknown;
  id: string;
  workflow_id: string;
  workflow_version: string;
  trigger: string;
  status: string;
  input: unknown;
  output: Record<string, unknown> | null;
  error: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
}

interface StageRow {
  [key: string]: unknown;
  id: string;
  run_id: string;
  stage_id: string;
  kind: string;
  status: string;
  attempts: number;
  output: unknown;
  error: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const toRun = (row: RunRow) =>
  RunDtoSchema.parse({
    id: row.id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    trigger: row.trigger,
    status: row.status,
    input: row.input ?? null,
    output: row.output ?? null,
    error: row.error ?? null,
    createdAt: iso(row.created_at),
    finishedAt: iso(row.finished_at),
  });

const toStage = (row: StageRow) =>
  StageRunDtoSchema.parse({
    id: row.id,
    runId: row.run_id,
    stageId: row.stage_id,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    output: row.output ?? null,
    error: row.error ?? null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  });

const RUN_COLUMNS = `id, workflow_id, workflow_version, trigger, status, input, output, error,
                     created_at, finished_at`;
const STAGE_COLUMNS = `id, run_id, stage_id, kind, status, attempts, output, error,
                       started_at, finished_at`;

async function stagesFor(database: Database, runIds: string[]): Promise<Map<string, StageRow[]>> {
  const byRun = new Map<string, StageRow[]>();
  if (runIds.length === 0) return byRun;
  const rows = await database.query<StageRow>(
    `SELECT ${STAGE_COLUMNS} FROM stage_runs
     WHERE run_id = ANY($1::text[])
     ORDER BY created_at`,
    [runIds],
  );
  for (const row of rows) byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row]);
  return byRun;
}

export function createRunReadApi(database: Database): RunReadApi {
  return {
    async get(id) {
      const rows = await database.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return null;
      const stages = await stagesFor(database, [row.id]);
      return { run: toRun(row), stages: (stages.get(row.id) ?? []).map(toStage) };
    },
    async list(filter: RunReadFilter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (filter.workflowId) add('workflow_id = ?', filter.workflowId);
      if (filter.status?.length)
        add(
          'status IN (SELECT jsonb_array_elements_text(?::jsonb))',
          JSON.stringify(filter.status),
        );
      if (filter.inputMatch) add('input @> ?::jsonb', filter.inputMatch);
      if (filter.ownerId) add('owner_id = ?', filter.ownerId);
      const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? 20)), 200);
      params.push(limit);
      const rows = await database.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM workflow_runs
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      const stages = await stagesFor(
        database,
        rows.map((row) => row.id),
      );
      return rows.map<RunWithStages>((row) => ({
        run: toRun(row),
        stages: (stages.get(row.id) ?? []).map(toStage),
      }));
    },
  };
}

export async function appendAudit(
  database: Database,
  moduleId: string,
  entry: AuditAppendInput,
): Promise<void> {
  const actor = entry.actor ?? `module:${moduleId}`;
  const payload = { ...(entry.payload ?? {}), moduleId };
  await database.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('audit:chain'))`);
    const last = await tx.query<{ hash: string | null }>(
      `SELECT hash FROM audit_events WHERE hash IS NOT NULL ORDER BY chain_seq DESC LIMIT 1`,
    );
    const prevHash = last[0]?.hash ?? null;
    const hash = auditHash({
      prevHash,
      actor,
      action: entry.action,
      subject: entry.subject ?? null,
      payload,
    });
    await tx.query(
      `INSERT INTO audit_events (id, actor, action, subject, payload, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ulid(), actor, entry.action, entry.subject ?? null, payload, prevHash, hash],
    );
  });
}

export async function readSetting<T = unknown>(database: Database, key: string): Promise<T | null> {
  const rows = await database.query<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [
    key,
  ]);
  return rows[0]?.value ?? null;
}

export async function recordCost(database: Database, entry: CostLedgerEntry): Promise<void> {
  await database.query(
    `INSERT INTO cost_ledger
       (id, run_id, stage_id, agent_id, task, provider, model,
        tokens_in, tokens_out, tokens_cached, est_cost, actual_cost, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      ulid(),
      entry.runId ?? null,
      entry.stageId ?? null,
      entry.agentId ?? null,
      entry.task,
      entry.provider,
      entry.model,
      entry.tokensIn ?? 0,
      entry.tokensOut ?? 0,
      entry.tokensCached ?? 0,
      entry.estCost ?? 0,
      entry.actualCost ?? null,
      entry.currency ?? 'USD',
    ],
  );
}

export async function tokensToday(database: Database, provider?: string): Promise<number> {
  const rows = provider
    ? await database.query<{ tokens: number }>(
        `SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::int AS tokens
           FROM cost_ledger
          WHERE provider = $1 AND at >= date_trunc('day', now())`,
        [provider],
      )
    : await database.query<{ tokens: number }>(
        `SELECT COALESCE(SUM(tokens_in + tokens_out), 0)::int AS tokens
           FROM cost_ledger
          WHERE at >= date_trunc('day', now())`,
      );
  return rows[0]?.tokens ?? 0;
}

export async function recordTrace(database: Database, entry: ModelTraceRecord): Promise<void> {
  await database.query(
    `INSERT INTO model_call_traces (trace_id, run_id, task, trace)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [entry.traceId, entry.runId, entry.task, entry.trace],
  );
}

export function createKnowledgeReadApi(database: Database): KnowledgeReadApi {
  return {
    async storageStats(collection) {
      const rows = await database.query<{
        chunks: number;
        text_bytes: string;
        vector_bytes: string;
      }>(
        `SELECT COUNT(*)::int AS chunks,
                COALESCE(SUM(octet_length(text)), 0)::bigint AS text_bytes,
                COALESCE(SUM(pg_column_size(embedding)), 0)::bigint AS vector_bytes
           FROM vector_chunks WHERE collection = $1`,
        [collection],
      );
      return {
        chunks: rows[0]?.chunks ?? 0,
        textBytes: Number(rows[0]?.text_bytes ?? 0),
        vectorBytes: Number(rows[0]?.vector_bytes ?? 0),
      };
    },
    async collectionHasRows(collection) {
      const rows = await database.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM vector_chunks WHERE collection = $1) AS exists`,
        [collection],
      );
      return Boolean(rows[0]?.exists);
    },
    async deleteCollection(collection) {
      await database.query(`DELETE FROM vector_chunks WHERE collection = $1`, [collection]);
    },
    async documentStats(collection) {
      const rows = await database.query<{
        documents: number;
        approved_documents: number;
        chunks: number;
      }>(
        `SELECT COUNT(DISTINCT document_id)::int AS documents,
                COUNT(DISTINCT document_id) FILTER (
                  WHERE metadata->>'approved' = 'true'
                )::int AS approved_documents,
                COUNT(*)::int AS chunks
           FROM vector_chunks WHERE collection = $1`,
        [collection],
      );
      return {
        documents: rows[0]?.documents ?? 0,
        approvedDocuments: rows[0]?.approved_documents ?? 0,
        chunks: rows[0]?.chunks ?? 0,
      };
    },
    async dailyCounts(collection, days) {
      const bounded = Math.min(Math.max(1, Math.trunc(days)), 90);
      const rows = await database.query<{ bucket: string; count: number }>(
        `SELECT to_char(date_trunc('day', updated_at), 'YYYY-MM-DD') AS bucket,
                COUNT(*)::int AS count
           FROM vector_chunks
          WHERE updated_at > now() - ($2::int * interval '1 day') AND collection = $1
          GROUP BY 1 ORDER BY 1`,
        [collection, bounded],
      );
      return rows;
    },
  };
}

export async function proposeFeedback(
  database: Database,
  entry: FeedbackProposal,
): Promise<{ id: string }> {
  const id = ulid();
  await database.query(
    `INSERT INTO candidate_examples
       (id, source, source_run_id, input, gold, provenance, status, actor)
     VALUES ($1, $2, $3, $4, $5, $6, 'proposed', $7)`,
    [
      id,
      entry.source,
      entry.sourceRunId ?? null,
      entry.input,
      entry.gold,
      entry.provenance,
      entry.actor ?? null,
    ],
  );
  return { id };
}

export type CoreContextApis = Pick<
  KernelContext,
  'runs' | 'audit' | 'settings' | 'skills' | 'costLedger' | 'traces' | 'knowledge' | 'feedback'
>;

export function createCoreContextApis(database: Database, moduleId: string): CoreContextApis {
  return {
    runs: createRunReadApi(database),
    audit: { append: (entry) => appendAudit(database, moduleId, entry) },
    settings: { get: (key) => readSetting(database, key) },
    skills: createSkillReadApi(database),
    costLedger: {
      record: (entry) => recordCost(database, entry),
      tokensToday: (provider) => tokensToday(database, provider),
    },
    traces: { record: (entry) => recordTrace(database, entry) },
    knowledge: createKnowledgeReadApi(database),
    feedback: { propose: (entry) => proposeFeedback(database, entry) },
  };
}
