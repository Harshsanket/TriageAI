/** Deterministic memory recall, listing and `memory.md` export (Phase 16.T5).
 * v1 is lexical because the `memories` table has no embedding column yet; the
 * scorer and filters stay stable when the vector migration lands. */
import { estimateTokens, maskPii } from '@triageai/rag';

import { invalid } from '../errors.js';
import type { Database } from '../types.js';
import {
  MEMORY_COLUMNS,
  memoryRelevance,
  rowToMemory,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
} from './types.js';

export interface MemoryRecallOptions {
  query: string;
  scope?: MemoryScope;
  scopeId?: string;
  /** Include agent-scope entries for this agent (OR with `workspaceId`). */
  agentId?: string;
  /** Include workspace-scope entries for this workspace (OR with `agentId`). */
  workspaceId?: string;
  kinds?: MemoryKind[];
  /** Defaults to active entries only. */
  statuses?: MemoryStatus[];
  limit?: number;
  /** Relevance floor in [0, 1]; defaults to the 0.75 memory floor. */
  floor?: number;
  /** Hard token ceiling for the returned set; defaults to 1024. */
  tokenCeiling?: number;
  /** Bump `use_count`/`last_used_at` for returned entries; defaults to true. */
  touch?: boolean;
  /** Query vector + model; when present, vector similarity blends with lexical. */
  queryEmbedding?: number[];
  embeddingModel?: string;
}

export interface MemoryRecallHit {
  entry: MemoryEntry;
  score: number;
  tokens: number;
}

export interface MemoryListOptions {
  scope?: MemoryScope;
  scopeId?: string;
  agentId?: string;
  workspaceId?: string;
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  limit?: number;
}

function whereClause(
  options: Pick<
    MemoryListOptions,
    'scope' | 'scopeId' | 'agentId' | 'workspaceId' | 'kinds' | 'statuses'
  >,
  params: unknown[],
): string {
  const clauses: string[] = [];
  if (options.scope) {
    if (!options.scopeId) throw invalid('a scoped memory query needs a scope id');
    params.push(options.scope);
    clauses.push(`scope = $${params.length}`);
    params.push(options.scopeId);
    clauses.push(`scope_id = $${params.length}`);
  } else if (options.agentId || options.workspaceId) {
    const allowed: string[] = [];
    if (options.agentId) {
      params.push(options.agentId);
      allowed.push(`(scope = 'agent' AND scope_id = $${params.length})`);
    }
    if (options.workspaceId) {
      params.push(options.workspaceId);
      allowed.push(`(scope = 'workspace' AND scope_id = $${params.length})`);
    }
    clauses.push(`(${allowed.join(' OR ')})`);
  } else {
    throw invalid('memory recall needs a scope, agent or workspace filter');
  }
  params.push(options.statuses ?? ['active']);
  clauses.push(`status = ANY($${params.length}::text[])`);
  clauses.push(`(expires_at IS NULL OR expires_at > now())`);
  if (options.kinds && options.kinds.length > 0) {
    params.push(options.kinds);
    clauses.push(`kind = ANY($${params.length}::text[])`);
  }
  return clauses.join(' AND ');
}

/**
 * Recall only entries that pass the relevance floor, then stop adding once the
 * token ceiling is reached. Ordering is score, then usage, then recency, then
 * id, so two identical stores always produce the same pack.
 */
export async function recallMemories(
  database: Database,
  options: MemoryRecallOptions,
): Promise<MemoryRecallHit[]> {
  if (options.query.trim().length === 0) throw invalid('memory recall needs a query');
  const limit = Math.max(1, Math.min(200, options.limit ?? 5));
  const floor = Math.max(0, Math.min(1, options.floor ?? 0.75));
  const tokenCeiling = Math.max(0, options.tokenCeiling ?? 1024);
  const params: unknown[] = [];
  const where = whereClause({ ...options, statuses: options.statuses ?? ['active'] }, params);
  const vector =
    options.queryEmbedding && options.queryEmbedding.length > 0 && options.embeddingModel
      ? {
          model: options.embeddingModel,
          literal: `[${options.queryEmbedding.join(',')}]`,
        }
      : null;
  let vectorScoreSelect = '';
  if (vector) {
    params.push(vector.model);
    const modelIndex = params.length;
    params.push(vector.literal);
    const vectorIndex = params.length;
    vectorScoreSelect = `,
      CASE WHEN embedding IS NOT NULL AND embedding_model = $${modelIndex}
           THEN 1 - (embedding <=> $${vectorIndex}::vector) END AS vector_score`;
  }
  params.push(Math.min(500, Math.max(limit * 5, 25)));
  const rows = await database.query<Record<string, unknown>>(
    `SELECT ${MEMORY_COLUMNS}${vectorScoreSelect} FROM memories
      WHERE ${where}
      ORDER BY created_at DESC, id ASC
      LIMIT $${params.length}`,
    params,
  );
  const hits = rows
    .map((row) => {
      const entry = rowToMemory(row);
      const lexical = memoryRelevance(options.query, entry.text);
      const vectorScore = row.vector_score == null ? null : Number(row.vector_score);
      return {
        entry,
        // Vector recall blends with lexical so exact terms still win ties.
        score: vectorScore == null ? lexical : 0.7 * vectorScore + 0.3 * lexical,
        tokens: estimateTokens(entry.text),
      };
    })
    .filter((hit) => hit.score >= floor)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.useCount - a.entry.useCount ||
        b.entry.createdAt.localeCompare(a.entry.createdAt) ||
        a.entry.id.localeCompare(b.entry.id),
    );
  const included: MemoryRecallHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (used + hit.tokens > tokenCeiling) continue;
    included.push(hit);
    used += hit.tokens;
    if (included.length >= limit) break;
  }
  if (options.touch !== false && included.length > 0) {
    const at = new Date().toISOString();
    await database.query(
      `UPDATE memories SET use_count = use_count + 1, last_used_at = now() WHERE id = ANY($1)`,
      [included.map((hit) => hit.entry.id)],
    );
    for (const hit of included) {
      hit.entry.useCount += 1;
      hit.entry.lastUsedAt = at;
    }
  }
  return included;
}

/** Unscored list for the viewer; includes proposed entries so lessons can be reviewed. */
export async function listMemories(
  database: Database,
  options: MemoryListOptions,
): Promise<MemoryEntry[]> {
  const limit = Math.max(1, Math.min(2000, options.limit ?? 200));
  const params: unknown[] = [];
  const where = whereClause(
    { ...options, statuses: options.statuses ?? ['active', 'proposed'] },
    params,
  );
  params.push(limit);
  const rows = await database.query<Record<string, unknown>>(
    `SELECT ${MEMORY_COLUMNS} FROM memories
      WHERE ${where}
      ORDER BY scope, scope_id, kind, created_at, id
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToMemory);
}

const SCOPE_ORDER: MemoryScope[] = ['agent', 'team', 'workspace', 'user', 'org'];
const KIND_ORDER: MemoryKind[] = ['fact', 'preference', 'procedure', 'lesson'];

function mask(text: string): string {
  return maskPii(text, 'log')
    .text.replace(/\s*\n\s*/g, ' ')
    .trim();
}

/**
 * One line per active entry, grouped by scope. Ordering is fully deterministic
 * (scope, scope id, kind, creation time, id) so the file can be diffed between
 * runs. PII is partially masked and secret values are redacted before export.
 */
export function memoryMarkdown(entries: MemoryEntry[]): string {
  const active = entries
    .filter((entry) => entry.status === 'active')
    .sort(
      (a, b) =>
        SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) ||
        a.scopeId.localeCompare(b.scopeId) ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  if (active.length === 0) return '# Memory\n\n_No active memories._\n';
  const lines = ['# Memory', ''];
  let group = '';
  for (const entry of active) {
    const key = `${entry.scope}:${entry.scopeId}`;
    if (key !== group) {
      group = key;
      lines.push(`## ${key}`, '');
    }
    const sources = [...new Set(entry.sourceRefs)].sort().map(mask).join(', ');
    lines.push(
      `- [${entry.kind}] ${mask(entry.text)} — sources: ${sources}; confidence ${entry.confidence.toFixed(2)}; used ${entry.useCount}${
        entry.derivedFromUntrusted ? '; untrusted' : ''
      }`,
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
