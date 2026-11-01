/**
 * Dead-letter read model + admin replay/discard (10C.T5). A job that exhausts
 * its queue attempts keeps its structured error here; replay puts the payload
 * back on the queue, discard removes it, and both actions are audited.
 */
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import type { Kernel } from '@triageai/kernel';
import { notFound } from '@triageai/kernel';
import {
  DeadLetterDiscardResponseSchema,
  DeadLetterDtoSchema,
  DeadLetterReplayResponseSchema,
  StructuredErrorSchema,
} from '@triageai/contracts';

import { writeAudit } from '../services/audit.js';

interface DeadLetterRow {
  [key: string]: unknown;
  id: string;
  queue: string;
  payload: unknown;
  attempts: number;
  error: string | null;
  created_at: Date | string;
}

function toDto(row: DeadLetterRow) {
  let errorDetails = null;
  if (row.error) {
    try {
      const parsed = StructuredErrorSchema.safeParse(JSON.parse(row.error));
      if (parsed.success) errorDetails = parsed.data;
    } catch {
      // Legacy rows stored a plain message.
    }
  }
  return DeadLetterDtoSchema.parse({
    id: row.id,
    queue: row.queue,
    payload: row.payload,
    attempts: row.attempts,
    error: errorDetails?.message ?? row.error ?? '',
    errorDetails,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

export function registerDeadLetterRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/deadletters', async (request) => {
    const query = request.query as { queue?: string; limit?: string };
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
    const rows = (await kernel.database.query<DeadLetterRow>(
      `SELECT id, queue, payload, attempts, error, created_at
       FROM queue_deadletters
       WHERE ($1::text IS NULL OR queue = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [query.queue ?? null, limit],
    )) as unknown as DeadLetterRow[];
    return rows.map(toDto);
  });

  app.post('/api/v1/system/deadletters/:id/replay', async (request) => {
    const { id } = request.params as { id: string };
    const rows = (await kernel.database.query<DeadLetterRow>(
      `SELECT id, queue, payload, attempts, error, created_at
       FROM queue_deadletters WHERE id = $1`,
      [id],
    )) as unknown as DeadLetterRow[];
    const dead = rows[0];
    if (!dead) throw notFound(`dead letter ${id} not found`, { deadLetterId: id });

    const jobId = ulid();
    await kernel.database.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO queue_jobs (id, queue, payload, status, attempts, max_attempts)
         VALUES ($1, $2, $3, 'pending', 0, 4)`,
        [jobId, dead.queue, dead.payload],
      );
      const deleted = await tx.query(`DELETE FROM queue_deadletters WHERE id = $1 RETURNING id`, [
        id,
      ]);
      if (deleted.length === 0) throw notFound(`dead letter ${id} not found`, { deadLetterId: id });
    });
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'deadletter.replayed',
      subject: id,
      payload: { queue: dead.queue, jobId, attempts: dead.attempts },
    });
    return DeadLetterReplayResponseSchema.parse({ id, replayed: true, jobId });
  });

  app.delete('/api/v1/system/deadletters/:id', async (request) => {
    const { id } = request.params as { id: string };
    const rows = (await kernel.database.query<DeadLetterRow>(
      `DELETE FROM queue_deadletters WHERE id = $1
       RETURNING id, queue, payload, attempts, error, created_at`,
      [id],
    )) as unknown as DeadLetterRow[];
    const discarded = rows[0];
    if (!discarded) throw notFound(`dead letter ${id} not found`, { deadLetterId: id });
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'deadletter.discarded',
      subject: id,
      payload: { queue: discarded.queue, attempts: discarded.attempts },
    });
    return DeadLetterDiscardResponseSchema.parse({ id, discarded: true });
  });
}
