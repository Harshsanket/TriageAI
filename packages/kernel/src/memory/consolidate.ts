/** Deterministic memory consolidation (Phase 16.T5): merge near-duplicates
 * inside one (scope, scope id, kind) group, union their provenance, and archive
 * the absorbed rows. Never merges across scopes, agents or kinds. Idempotent:
 * a second pass sees no non-archived duplicates. */
import type { Database } from '../types.js';
import { listMemories } from './recall.js';
import {
  similarity,
  tokens,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemoryStatus,
} from './types.js';

export interface ConsolidateOptions {
  scope?: MemoryScope;
  scopeId?: string;
  agentId?: string;
  workspaceId?: string;
  kind?: MemoryKind;
  /** Token similarity at or above which entries merge; defaults to 0.9. */
  threshold?: number;
  /** Compute the plan without writing (tests / dry runs). */
  dryRun?: boolean;
}

export interface ConsolidationResult {
  groups: number;
  merged: number;
  archivedIds: string[];
  keptIds: string[];
}

function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Deterministic summarise: keep the survivor's wording, add only clauses the
 * survivor does not already contain, and stay inside the 300-char cap. */
export function mergeMemoryText(left: string, right: string): string {
  if (left === right) return left;
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const subset = (a: Set<string>, b: Set<string>): boolean => [...a].every((token) => b.has(token));
  if (subset(leftTokens, rightTokens)) return right.length >= left.length ? right : left;
  if (subset(rightTokens, leftTokens)) return left.length >= right.length ? left : right;
  const parts: string[] = [];
  for (const part of [...clauses(left), ...clauses(right)]) {
    if (!parts.some((existing) => existing.toLowerCase() === part.toLowerCase())) parts.push(part);
  }
  const joined = parts.join(' ');
  if (joined.length <= 300) return joined;
  let output = '';
  for (const part of parts) {
    const next = output ? `${output} ${part}` : part;
    if (next.length > 300) break;
    output = next;
  }
  return (output || parts[0] || left).slice(0, 300);
}

function mergedEntry(cluster: MemoryEntry[]): MemoryEntry {
  const survivor = cluster[0] as MemoryEntry;
  const absorbed = cluster.slice(1);
  const sourceRefs = [...new Set(cluster.flatMap((entry) => entry.sourceRefs))];
  const status: MemoryStatus = cluster.some((entry) => entry.status === 'active')
    ? 'active'
    : survivor.status;
  const lastUsedAt = cluster
    .map((entry) => entry.lastUsedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return {
    ...survivor,
    text: absorbed.reduce((text, entry) => mergeMemoryText(text, entry.text), survivor.text),
    sourceRefs,
    confidence: Math.max(...cluster.map((entry) => entry.confidence)),
    status,
    derivedFromUntrusted: cluster.some((entry) => entry.derivedFromUntrusted),
    useCount: cluster.reduce((total, entry) => total + entry.useCount, 0),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    supersedes: survivor.supersedes ?? absorbed.at(-1)?.id ?? survivor.id,
  };
}

/**
 * One pass over every non-archived group. The survivor is the highest
 * confidence entry, then the oldest; entries join the first cluster whose
 * survivor is similar enough (chaining is allowed inside the group only).
 */
export async function consolidateMemories(
  database: Database,
  options: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const threshold = Math.max(0, Math.min(1, options.threshold ?? 0.9));
  const entries = await listMemories(database, {
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.scopeId ? { scopeId: options.scopeId } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(options.kind ? { kinds: [options.kind] } : {}),
    statuses: ['active', 'proposed'],
    limit: 2000,
  });
  const grouped = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const key = `${entry.scope}\u0000${entry.scopeId}\u0000${entry.kind}`;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }

  const plans: Array<{ survivor: MemoryEntry; absorbed: MemoryEntry[] }> = [];
  for (const group of grouped.values()) {
    const ordered = [...group].sort(
      (a, b) =>
        b.confidence - a.confidence ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    const clusters: MemoryEntry[][] = [];
    for (const entry of ordered) {
      const cluster = clusters.find(
        (candidate) => similarity((candidate[0] as MemoryEntry).text, entry.text) >= threshold,
      );
      if (cluster) cluster.push(entry);
      else clusters.push([entry]);
    }
    for (const cluster of clusters) {
      if (cluster.length < 2) continue;
      plans.push({
        survivor: mergedEntry(cluster),
        absorbed: cluster.slice(1),
      });
    }
  }

  if (!options.dryRun && plans.length > 0) {
    await database.transaction(async (tx) => {
      for (const plan of plans) {
        await tx.query(
          `UPDATE memories
              SET text = $2, source_refs = $3, confidence = $4, status = $5,
                  supersedes = $6, derived_from_untrusted = $7, use_count = $8,
                  last_used_at = $9
            WHERE id = $1`,
          [
            plan.survivor.id,
            plan.survivor.text,
            plan.survivor.sourceRefs,
            plan.survivor.confidence,
            plan.survivor.status,
            plan.survivor.supersedes ?? null,
            plan.survivor.derivedFromUntrusted,
            plan.survivor.useCount,
            plan.survivor.lastUsedAt ?? null,
          ],
        );
        await tx.query(
          `UPDATE memories SET status = 'archived'
            WHERE id = ANY($1) AND status <> 'archived'`,
          [plan.absorbed.map((entry) => entry.id)],
        );
      }
    });
  }

  return {
    groups: grouped.size,
    merged: plans.reduce((total, plan) => total + plan.absorbed.length, 0),
    archivedIds: plans.flatMap((plan) => plan.absorbed.map((entry) => entry.id)),
    keptIds: plans.map((plan) => plan.survivor.id),
  };
}
