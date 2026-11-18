/** Legal holds and "forget me" (Phase 18.8/18.T17): admin-only, audited. */
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { z } from 'zod';

import { DEFAULT_DATA_CLASSES, forgetSubject, invalid, notFound } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';

const HoldCreateSchema = z
  .object({
    classId: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(1).max(500),
    expiresAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), 'expiresAt must be an ISO date')
      .nullable()
      .optional(),
  })
  .strict();

const ForgetSchema = z.object({ subject: z.string().trim().min(1).max(320) }).strict();

interface HoldRow {
  [key: string]: unknown;
  id: string;
  class_id: string;
  reason: string;
  created_by: string | null;
  created_at: Date | string;
  expires_at: Date | string | null;
}

function toHold(row: HoldRow) {
  const expiresAt = row.expires_at ? new Date(row.expires_at).toISOString() : null;
  return {
    id: row.id,
    classId: row.class_id,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt,
    active: expiresAt === null || Date.parse(expiresAt) > Date.now(),
  };
}

export function registerLegalHoldRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/legal-holds', async () => {
    const rows = await kernel.database.query<HoldRow>(
      `SELECT id, class_id, reason, created_by, created_at, expires_at
         FROM legal_holds ORDER BY created_at DESC`,
    );
    return { holds: rows.map(toHold) };
  });

  app.post('/api/v1/system/legal-holds', async (request) => {
    const body = HoldCreateSchema.parse(request.body ?? {});
    const cls = DEFAULT_DATA_CLASSES[body.classId];
    if (!cls) throw invalid(`unknown data class "${body.classId}"`);
    if (!cls.retention.legalHoldable) {
      throw invalid(`data class "${body.classId}" does not support legal holds`);
    }
    const id = ulid();
    const actor = request.principal?.email ?? 'admin';
    const rows = await kernel.database.query<HoldRow>(
      `INSERT INTO legal_holds (id, class_id, reason, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, class_id, reason, created_by, created_at, expires_at`,
      [id, body.classId, body.reason, actor, body.expiresAt ?? null],
    );
    await writeAudit(kernel.database, {
      actor,
      action: 'legal_hold.created',
      subject: body.classId,
      payload: { holdId: id, reason: body.reason, expiresAt: body.expiresAt ?? null },
    });
    return toHold(rows[0] as HoldRow);
  });

  app.delete('/api/v1/system/legal-holds/:id', async (request) => {
    const { id } = request.params as { id: string };
    const rows = await kernel.database.query<{ class_id: string; reason: string }>(
      `DELETE FROM legal_holds WHERE id = $1 RETURNING class_id, reason`,
      [id],
    );
    const hold = rows[0];
    if (!hold) throw notFound(`legal hold ${id} not found`);
    const actor = request.principal?.email ?? 'admin';
    await writeAudit(kernel.database, {
      actor,
      action: 'legal_hold.released',
      subject: hold.class_id,
      payload: { holdId: id, reason: hold.reason },
    });
    return { released: id, classId: hold.class_id };
  });

  app.post('/api/v1/system/forget-me', async (request) => {
    const body = ForgetSchema.parse(request.body ?? {});
    const result = await forgetSubject(kernel.database, body.subject);
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? 'admin',
      action: 'privacy.forget_me',
      subject: body.subject,
      payload: { deleted: result.deleted, skipped: result.skipped },
    });
    return result;
  });
}
