/**
 * Consequential actions write an append-only audit row (ARCHITECTURE §9):
 * feedback review, dataset builds, model registration/promotion/rollback.
 */
import { ulid } from 'ulid';

import type { Database } from '@triageai/kernel';

import { auditHash } from './auditChain.js';

export async function writeAudit(
  database: Database,
  entry: {
    actor: string | null;
    action: string;
    subject?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await database.transaction(async (tx) => {
    // Serialise appends so concurrent writers cannot fork the chain. Existing
    // rows from before the chain landed have NULL hashes; the verifier reports
    // that as a break instead of pretending they are valid.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('audit:chain'))`);
    const last = await tx.query<{ hash: string | null }>(
      `SELECT hash FROM audit_events WHERE hash IS NOT NULL ORDER BY chain_seq DESC LIMIT 1`,
    );
    const prevHash = last[0]?.hash ?? null;
    const hash = auditHash({
      prevHash,
      actor: entry.actor,
      action: entry.action,
      subject: entry.subject ?? null,
      payload: entry.payload ?? {},
    });
    await tx.query(
      `INSERT INTO audit_events (id, actor, action, subject, payload, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ulid(),
        entry.actor,
        entry.action,
        entry.subject ?? null,
        entry.payload ?? {},
        prevHash,
        hash,
      ],
    );
  });
}
