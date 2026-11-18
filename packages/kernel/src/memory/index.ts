/**
 * Long-term memory (Phase 16, ADR-0036): one sourced fact per entry, 300-char
 * cap, volatile fields rejected with the live-source tool named, and lessons
 * proposed rather than activated. Recall, consolidation and `memory.md` export
 * live in sibling files; this file is the store and validation entry point.
 */
import { ulid } from 'ulid';

import { AppError, notFound } from '../errors.js';
import type { Database } from '../types.js';
import {
  consolidateMemories,
  type ConsolidateOptions,
  type ConsolidationResult,
} from './consolidate.js';
import {
  listMemories,
  memoryMarkdown,
  recallMemories,
  type MemoryListOptions,
  type MemoryRecallHit,
  type MemoryRecallOptions,
} from './recall.js';
import {
  MEMORY_COLUMNS,
  rowToMemory,
  similarity,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
} from './types.js';
import {
  validateMemoryInput,
  type MemoryLiveToolLookup,
  type MemoryWriteContext,
} from './validation.js';

export * from './consolidate.js';
export * from './recall.js';
export * from './types.js';
export * from './validation.js';

export class MemoryStore {
  constructor(private readonly database: Database) {}

  async write(args: {
    scope: MemoryScope;
    scopeId: string;
    kind: MemoryKind;
    text: string;
    sourceRefs: string[];
    confidence?: number;
    derivedFromUntrusted?: boolean;
    liveTools?: MemoryLiveToolLookup;
    liveSourceRefs?: string[];
  }): Promise<MemoryEntry> {
    const context: MemoryWriteContext = {
      ...(args.liveTools ? { liveTools: args.liveTools } : {}),
      ...(args.liveSourceRefs ? { liveSourceRefs: args.liveSourceRefs } : {}),
    };
    validateMemoryInput(args, context);
    // Near-duplicates merge; contradictions supersede the older entry (16).
    const existing = await this.database.query<Record<string, unknown>>(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE scope = $1 AND scope_id = $2 AND kind = $3 AND status <> 'archived'
       ORDER BY created_at DESC LIMIT 10`,
      [args.scope, args.scopeId, args.kind],
    );
    const duplicate = existing.find((row) => similarity(String(row.text), args.text) >= 0.9);
    const status: MemoryStatus =
      args.kind === 'lesson' || args.kind === 'procedure' ? 'proposed' : 'active';
    if (duplicate) {
      const mergedText =
        String(duplicate.text).length >= args.text.length ? String(duplicate.text) : args.text;
      const rows = await this.database.query<Record<string, unknown>>(
        `UPDATE memories SET text = $2, source_refs = $3, confidence = $4, last_used_at = now()
         WHERE id = $1 RETURNING ${MEMORY_COLUMNS}`,
        [
          duplicate.id,
          mergedText.slice(0, 300),
          [...new Set([...(duplicate.source_refs as string[]), ...args.sourceRefs])],
          Math.max(Number(duplicate.confidence), args.confidence ?? 1),
        ],
      );
      return rowToMemory(rows[0] as Record<string, unknown>);
    }
    const id = ulid();
    const rows = await this.database.query<Record<string, unknown>>(
      `INSERT INTO memories
         (id, scope, scope_id, kind, text, source_refs, confidence, status, derived_from_untrusted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${MEMORY_COLUMNS}`,
      [
        id,
        args.scope,
        args.scopeId,
        args.kind,
        args.text,
        args.sourceRefs,
        args.confidence ?? 1,
        status,
        args.derivedFromUntrusted ?? false,
      ],
    );
    return rowToMemory(rows[0] as Record<string, unknown>);
  }

  /** Lexical v1 retrieval; a vector index lands with the memory embedding migration. */
  async search(
    scope: MemoryScope,
    scopeId: string,
    query: string,
    limit = 5,
  ): Promise<MemoryEntry[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT ${MEMORY_COLUMNS} FROM memories
       WHERE scope = $1 AND scope_id = $2 AND status = 'active'
         AND text ILIKE '%' || $3 || '%'
       ORDER BY use_count DESC, created_at DESC LIMIT $4`,
      [scope, scopeId, query, limit],
    );
    if (rows.length > 0) {
      await this.database.query(
        `UPDATE memories SET use_count = use_count + 1, last_used_at = now()
         WHERE id = ANY($1)`,
        [rows.map((row) => row.id)],
      );
    }
    return rows.map(rowToMemory);
  }

  /** Relevance-gated recall across an agent and/or workspace scope. */
  async recall(options: MemoryRecallOptions): Promise<MemoryRecallHit[]> {
    return recallMemories(this.database, options);
  }

  async list(options: MemoryListOptions): Promise<MemoryEntry[]> {
    return listMemories(this.database, options);
  }

  /** Deterministic `memory.md` body for one scope (active entries only). */
  async exportMarkdown(scope: MemoryScope, scopeId: string): Promise<string> {
    return memoryMarkdown(await this.list({ scope, scopeId, statuses: ['active'], limit: 2000 }));
  }

  async consolidate(options: ConsolidateOptions = {}): Promise<ConsolidationResult> {
    return consolidateMemories(this.database, options);
  }

  /** Review gate for proposed procedures/lessons. */
  async review(
    id: string,
    status: Extract<MemoryStatus, 'active' | 'archived'>,
  ): Promise<MemoryEntry> {
    const rows = await this.database.query<Record<string, unknown>>(
      `UPDATE memories SET status = $2 WHERE id = $1 RETURNING ${MEMORY_COLUMNS}`,
      [id, status],
    );
    if (!rows[0]) throw notFound(`memory ${id} not found`);
    return rowToMemory(rows[0]);
  }

  async forgetUser(scopeId: string): Promise<number> {
    const rows = await this.database.query(
      `DELETE FROM memories WHERE scope = 'user' AND scope_id = $1 RETURNING id`,
      [scopeId],
    );
    return rows.length;
  }
}

export { AppError };
