/**
 * Read-only audit trail (Phase 6): feedback reviews, dataset builds, and model
 * registry changes are written by their routes and inspectable here.
 */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

interface AuditRow {
  [key: string]: unknown;
  id: string;
  actor: string | null;
  action: string;
  subject: string | null;
  payload: Record<string, unknown>;
  created_at: Date | string;
}

export function registerAuditRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/audit', async (request) => {
    const query = request.query as { action?: string; subject?: string; limit?: string };
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
    const rows = (await kernel.database.query<AuditRow>(
      `SELECT id, actor, action, subject, payload, created_at
       FROM audit_events
       WHERE ($1::text IS NULL OR action = $1)
         AND ($2::text IS NULL OR subject = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [query.action ?? null, query.subject ?? null, limit],
    )) as unknown as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      subject: row.subject,
      payload: row.payload ?? {},
      createdAt: new Date(row.created_at).toISOString(),
    }));
  });
}
