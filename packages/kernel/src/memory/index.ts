/**
 * Long-term memory (Phase 16, ADR-0036): one sourced fact per entry, 300-char
 * cap, volatile fields rejected with the live-source tool named, and lessons
 * proposed rather than activated.
 */
import { ulid } from 'ulid';

import { AppError, invalid } from '../errors.js';
import type { Database } from '../types.js';

export type MemoryScope = 'agent' | 'team' | 'workspace' | 'user' | 'org';
export type MemoryKind = 'fact' | 'preference' | 'procedure' | 'lesson';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  kind: MemoryKind;
  text: string;
  sourceRefs: string[];
  confidence: number;
  status: 'proposed' | 'active' | 'archived';
  supersedes?: string;
  derivedFromUntrusted: boolean;
  lastUsedAt?: string;
  useCount: number;
  expiresAt?: string;
}

const VOLATILE: Array<{ pattern: RegExp; liveTool: string }> = [
  { pattern: /\b(status|state)\b/i, liveTool: 'support.get_ticket' },
  { pattern: /\b(plan|tier|subscription)\b/i, liveTool: 'crm.get_deal' },
  { pattern: /\b(price|cost|balance|amount)\b/i, liveTool: 'crm.get_deal' },
  { pattern: /\b(assignee|owner|due date|quota)\b/i, liveTool: 'support.get_ticket' },
];

/** Rejects a memory that should be fetched live instead (16 §Memory). */
export function volatileFieldTool(text: string): string | null {
  return VOLATILE.find((entry) => entry.pattern.test(text))?.liveTool ?? null;
}

export function validateMemoryInput(args: {
  text: string;
  sourceRefs: string[];
  kind: MemoryKind;
}): void {
  if (args.text.length === 0 || args.text.length > 300) {
    throw invalid('a memory entry must be 1–300 characters');
  }
  if (args.sourceRefs.length === 0) throw invalid('a memory entry needs at least one source ref');
  const live = volatileFieldTool(args.text);
  if (live) {
    throw invalid(`volatile facts are not memorised; read ${live} instead`);
  }
  if (
    args.kind === 'lesson' &&
    /\b(on|at)\s+\d{1,2}\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(
      args.text,
    )
  ) {
    throw invalid('a lesson must be a general rule, not a dated incident');
  }
}

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
  }): Promise<MemoryEntry> {
    validateMemoryInput(args);
    // Near-duplicates merge; contradictions supersede the older entry (16).
    const existing = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM memories
       WHERE scope = $1 AND scope_id = $2 AND kind = $3 AND status <> 'archived'
       ORDER BY created_at DESC LIMIT 10`,
      [args.scope, args.scopeId, args.kind],
    );
    const duplicate = existing.find((row) => similarity(String(row.text), args.text) >= 0.9);
    const status = args.kind === 'lesson' || args.kind === 'procedure' ? 'proposed' : 'active';
    if (duplicate) {
      const mergedText =
        String(duplicate.text).length >= args.text.length ? String(duplicate.text) : args.text;
      const rows = await this.database.query<Record<string, unknown>>(
        `UPDATE memories SET text = $2, source_refs = $3, confidence = $4, last_used_at = now()
         WHERE id = $1 RETURNING *`,
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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
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

  /** Lexical v1 retrieval; a vector index lands with 18.T9. */
  async search(
    scope: MemoryScope,
    scopeId: string,
    query: string,
    limit = 5,
  ): Promise<MemoryEntry[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM memories
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

  async forgetUser(scopeId: string): Promise<number> {
    const rows = await this.database.query(
      `DELETE FROM memories WHERE scope = 'user' AND scope_id = $1 RETURNING id`,
      [scopeId],
    );
    return rows.length;
  }
}

function rowToMemory(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    scope: row.scope as MemoryScope,
    scopeId: row.scope_id as string,
    kind: row.kind as MemoryKind,
    text: row.text as string,
    sourceRefs: (row.source_refs as string[]) ?? [],
    confidence: Number(row.confidence),
    status: row.status as MemoryEntry['status'],
    ...(row.supersedes ? { supersedes: row.supersedes as string } : {}),
    derivedFromUntrusted: Boolean(row.derived_from_untrusted),
    ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at as string).toISOString() } : {}),
    useCount: Number(row.use_count),
    ...(row.expires_at ? { expiresAt: new Date(row.expires_at as string).toISOString() } : {}),
  };
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

export { AppError };
