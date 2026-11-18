/** Memory row shape and deterministic lexical scoring shared by the store,
 * recall and consolidation paths (Phase 16.T5/T9). */
import { detect } from '@triageai/rag';

export type MemoryScope = 'agent' | 'team' | 'workspace' | 'user' | 'org';
export type MemoryKind = 'fact' | 'preference' | 'procedure' | 'lesson';
export type MemoryStatus = 'proposed' | 'active' | 'archived';
export type MemorySensitivity = 'public' | 'internal' | 'restricted' | 'secret';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  scopeId: string;
  kind: MemoryKind;
  text: string;
  sourceRefs: string[];
  confidence: number;
  status: MemoryStatus;
  supersedes?: string;
  derivedFromUntrusted: boolean;
  lastUsedAt?: string;
  useCount: number;
  expiresAt?: string;
  createdAt: string;
  /** Derived from the text at read time; no extra column is required. */
  sensitivity: MemorySensitivity;
}

export const MEMORY_COLUMNS = `id, scope, scope_id, kind, text, source_refs, confidence, status,
  supersedes, derived_from_untrusted, last_used_at, use_count, expires_at, created_at`;

export function rowToMemory(row: Record<string, unknown>): MemoryEntry {
  const text = String(row.text ?? '');
  return {
    id: row.id as string,
    scope: row.scope as MemoryScope,
    scopeId: row.scope_id as string,
    kind: row.kind as MemoryKind,
    text,
    sourceRefs: (row.source_refs as string[]) ?? [],
    confidence: Number(row.confidence),
    status: row.status as MemoryStatus,
    ...(row.supersedes ? { supersedes: row.supersedes as string } : {}),
    derivedFromUntrusted: Boolean(row.derived_from_untrusted),
    ...(row.last_used_at ? { lastUsedAt: new Date(row.last_used_at as string).toISOString() } : {}),
    useCount: Number(row.use_count),
    ...(row.expires_at ? { expiresAt: new Date(row.expires_at as string).toISOString() } : {}),
    createdAt: row.created_at
      ? new Date(row.created_at as string).toISOString()
      : new Date(0).toISOString(),
    sensitivity: detect(text).sensitivity,
  };
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'should',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

function stem(token: string): string {
  let value = token;
  if (value.length > 4 && value.endsWith('ies')) value = `${value.slice(0, -3)}y`;
  else if (value.length > 4 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss'))
    value = value.slice(0, -1);
  else if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  if (value.length > 3 && /([a-z])\1$/.test(value)) value = value.slice(0, -1);
  return value;
}

/** Content tokens only: lowercased, stopwords removed, light stemming. */
export function tokens(text: string): Set<string> {
  const values = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    values.add(stem(raw));
  }
  return values;
}

/**
 * Deterministic lexical relevance in [0, 1]. Coverage (how much of the query
 * the entry explains) is the primary signal; F1 breaks ties toward entries
 * that do not pad the match with unrelated tokens. A literal substring match
 * is always 1. This is the fallback until the `memories.embedding` migration
 * lands (see the 16.T5 report).
 */
export function memoryRelevance(query: string, text: string): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length >= 3 && text.toLowerCase().includes(normalizedQuery)) return 1;
  const left = tokens(query);
  const right = tokens(text);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const coverage = shared / left.size;
  const precision = shared / right.size;
  const f1 = coverage + precision === 0 ? 0 : (2 * coverage * precision) / (coverage + precision);
  return Math.round(Math.max(coverage, f1) * 1000) / 1000;
}

/** Near-duplicate similarity used by writes and consolidation. */
export function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}
