/**
 * Consequential actions write an append-only audit row (ARCHITECTURE §9):
 * feedback review, dataset builds, model registration/promotion/rollback.
 */
import { ulid } from 'ulid';

import type { Database } from '@triageai/kernel';

export async function writeAudit(
  database: Database,
  entry: {
    actor: string | null;
    action: string;
    subject?: string | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await database.query(
    `INSERT INTO audit_events (id, actor, action, subject, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [ulid(), entry.actor, entry.action, entry.subject ?? null, entry.payload ?? {}],
  );
}
