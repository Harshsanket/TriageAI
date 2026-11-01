/** Tamper-evident audit chain (Phase 18.5): every row hashes the previous one. */
import type { Database } from '@triageai/kernel';
import { auditHash } from '@triageai/kernel';

export { auditHash };

export async function verifyAuditChain(
  database: Database,
): Promise<{ ok: boolean; checked: number; brokenAt?: string; reason?: string }> {
  const rows = await database.query<{
    id: string;
    actor: string | null;
    action: string;
    subject: string | null;
    payload: unknown;
    prev_hash: string | null;
    hash: string | null;
  }>(
    `SELECT id, actor, action, subject, payload, prev_hash, hash
     FROM audit_events ORDER BY chain_seq NULLS FIRST, created_at, id`,
  );
  let previous: string | null = null;
  for (const row of rows) {
    // Rows written before migration 0012 have no hash; they are legacy, not a
    // tamper signal. Hashed rows verify among themselves, so deleting one still
    // breaks the chain.
    if (row.hash === null) continue;
    const expected = auditHash({
      prevHash: previous,
      actor: row.actor,
      action: row.action,
      subject: row.subject,
      payload: row.payload,
    });
    if (row.prev_hash !== previous || row.hash !== expected) {
      return { ok: false, checked: rows.length, brokenAt: row.id, reason: 'hash_mismatch' };
    }
    previous = row.hash;
  }
  return { ok: true, checked: rows.length };
}
