/**
 * 18.T31 audited privacy reveal. Reads stay masked by default; an admin can
 * reveal one field at a time here, and every reveal writes an audit row.
 * Only owning business records are revealable; scrubbed secrets are gone.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { notFound } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';

const RevealSchema = z
  .object({
    kind: z.literal('ticket_message'),
    ticketId: z.string().min(1).max(80),
    messageId: z.string().min(1).max(80),
  })
  .strict();

export function registerPrivacyRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.post('/api/v1/system/reveal', async (request) => {
    const body = RevealSchema.parse(request.body ?? {});
    if (!kernel.modules.includes('support')) {
      throw notFound('the support module is not enabled');
    }
    const rows = await kernel.database.query<{
      body: string;
      sensitivity: string;
      tags: string[];
    }>(
      `SELECT body, sensitivity, tags
         FROM mod_support.support_ticket_messages
        WHERE id = $1 AND ticket_id = $2`,
      [body.messageId, body.ticketId],
    );
    const row = rows[0];
    if (!row) throw notFound(`ticket message ${body.messageId} not found`);
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'privacy.revealed',
      subject: body.messageId,
      payload: {
        kind: body.kind,
        ticketId: body.ticketId,
        sensitivity: row.sensitivity,
        tags: row.tags,
      },
    });
    return {
      kind: body.kind,
      messageId: body.messageId,
      value: row.body,
      sensitivity: row.sensitivity,
      tags: row.tags,
    };
  });
}
