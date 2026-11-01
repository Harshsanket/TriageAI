/**
 * emailer (Phase 13.T2): signed inbound webhook → support tickets (through
 * events), email threading, and an approval-gated outbound outbox.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ulid } from 'ulid';
import { z } from 'zod';

import { AppError, invalid } from '@triageai/kernel';
import type { TriageModule } from '@triageai/kernel';

import { sendMail, type SmtpConfig } from './smtp.js';

const configSchema = z
  .object({
    fromAddress: z.string().email().default('noreply@triageai.local'),
    requireApproval: z.boolean().default(true),
    smtpPort: z.number().int().positive().default(587),
    smtpSecure: z.boolean().default(false),
  })
  .strict();

const MIGRATIONS = [
  {
    id: '0001-email-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS email_threads (
        message_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'inbound',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS email_threads_ticket ON email_threads (ticket_id);
      CREATE TABLE IF NOT EXISTS email_outbox (
        id TEXT PRIMARY KEY,
        ticket_id TEXT,
        to_address TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending_approval',
        error TEXT,
        message_id TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        sent_at TIMESTAMPTZ
      );
    `,
    dropSql: 'DROP TABLE IF EXISTS email_outbox; DROP TABLE IF EXISTS email_threads;',
  },
  {
    id: '0002-email-inbound-dedupe',
    sql: `
      CREATE TABLE IF NOT EXISTS email_inbound_seen (
        message_id TEXT PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
    dropSql: 'DROP TABLE IF EXISTS email_inbound_seen;',
  },
];

const InboundSchema = z
  .object({
    messageId: z.string().min(1).max(500),
    from: z.string().email(),
    to: z.string().email().optional(),
    subject: z.string().max(300).default('(no subject)'),
    text: z.string().min(1).max(20_000),
    inReplyTo: z.string().max(500).optional(),
  })
  .strict();

const OutboundSchema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000),
    ticketId: z.string().optional(),
    inReplyTo: z.string().optional(),
  })
  .strict();

function verifySignature(
  rawBody: string | undefined,
  signature: string | undefined,
  timestamp: string | undefined,
  secret: string,
): void {
  if (!rawBody || !signature) {
    throw new AppError('emailer.SIGNATURE_REQUIRED', 'a signed body is required', undefined, 401, {
      category: 'unauthenticated',
    });
  }
  if (!timestamp || !/^\d{9,13}$/.test(timestamp)) {
    throw new AppError(
      'emailer.TIMESTAMP_REQUIRED',
      'a signed timestamp header is required',
      undefined,
      401,
      { category: 'unauthenticated' },
    );
  }
  const seconds = Number(timestamp.length > 10 ? Math.floor(Number(timestamp) / 1000) : timestamp);
  if (Math.abs(Date.now() / 1000 - seconds) > 300) {
    throw new AppError(
      'emailer.TIMESTAMP_EXPIRED',
      'the signed timestamp is outside the 5 minute window',
      undefined,
      401,
      { category: 'unauthenticated' },
    );
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const provided = signature.replace(/^sha256=/, '');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw new AppError('emailer.SIGNATURE_INVALID', 'email signature mismatch', undefined, 401, {
      category: 'unauthenticated',
    });
  }
}

export const emailerModule: TriageModule = {
  id: 'emailer',
  version: '0.1.0',
  capabilities: ['queue', 'eventBus'],
  permissions: {
    storage: { schema: true },
    routes: [
      { method: 'GET', path: '/api/v1/emailer/outbox' },
      { method: 'GET', path: '/api/v1/emailer/threads' },
      { method: 'POST', path: '/api/v1/emailer/inbound' },
      { method: 'POST', path: '/api/v1/emailer/outbox/:id/approve' },
      { method: 'POST', path: '/api/v1/emailer/send' },
    ],
    events: {
      namespace: 'email',
      publish: ['email.received', 'email.reply_received'],
      subscribe: ['support.ticket.created'],
    },
    capabilities: { consume: ['queue', 'eventBus'], provide: [] },
    stages: [],
    workflows: [],
    evals: [],
    tools: [],
    knowledge: { read: [], write: [] },
  },
  dependsOn: { capabilities: [] },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['email_threads', 'email_outbox', 'email_inbound_seen'],
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: { health: async () => ({ status: 'healthy', detail: 'email in/out' }) },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const inboundSecret = ctx.env.EMAIL_INBOUND_SECRET;
    const smtp: SmtpConfig | null = ctx.env.EMAIL_SMTP_HOST
      ? {
          host: ctx.env.EMAIL_SMTP_HOST,
          port: Number(ctx.env.EMAIL_SMTP_PORT ?? options.smtpPort),
          secure: ctx.env.EMAIL_SMTP_SECURE === '1' || options.smtpSecure,
          user: ctx.env.EMAIL_SMTP_USER,
          pass: ctx.env.EMAIL_SMTP_PASS,
          from: ctx.env.EMAIL_FROM ?? options.fromAddress,
        }
      : null;

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/emailer/inbound',
      handler: async (request) => {
        if (!inboundSecret) {
          throw new AppError(
            'emailer.UNAVAILABLE',
            'EMAIL_INBOUND_SECRET is not configured',
            undefined,
            503,
            { category: 'dependency_unavailable', retryable: false },
          );
        }
        verifySignature(
          request.rawBody,
          request.headers?.['x-emailer-signature'] ?? request.headers?.['x-hub-signature-256'],
          request.headers?.['x-emailer-timestamp'],
          inboundSecret,
        );
        const body = InboundSchema.parse(request.body ?? {});
        const seen = await ctx.database.query<{ message_id: string }>(
          `INSERT INTO email_inbound_seen (message_id) VALUES ($1)
           ON CONFLICT (message_id) DO NOTHING RETURNING message_id`,
          [body.messageId],
        );
        if (seen.length === 0) return { accepted: true, deduped: true };
        const threaded = body.inReplyTo
          ? await ctx.database.query<{ ticket_id: string }>(
              `SELECT ticket_id FROM email_threads WHERE message_id = $1`,
              [body.inReplyTo],
            )
          : [];
        if (threaded[0]) {
          await ctx.events.publish('email.reply_received', {
            ticketId: threaded[0].ticket_id,
            messageId: body.messageId,
            from: body.from,
            text: body.text,
          });
          return { accepted: true, threaded: true, ticketId: threaded[0].ticket_id };
        }
        await ctx.events.publish('email.received', body);
        return { accepted: true, threaded: false };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/emailer/threads',
      handler: async () => {
        const rows = await ctx.database.query<Record<string, unknown>>(
          `SELECT message_id, ticket_id, direction, created_at
           FROM email_threads ORDER BY created_at DESC LIMIT 100`,
        );
        return rows.map((row) => ({
          messageId: row.message_id,
          ticketId: row.ticket_id,
          direction: row.direction,
          createdAt: row.created_at,
        }));
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/emailer/send',
      handler: async (request) => {
        const body = OutboundSchema.parse(request.body ?? {});
        if (body.ticketId) {
          const rows = await ctx.database.query<{ id: string }>(
            `SELECT id FROM email_outbox WHERE ticket_id = $1 AND status = 'sent' LIMIT 1`,
            [body.ticketId],
          );
          if (rows[0] && body.inReplyTo) {
            // repeat detection: one sent reply per customer message
            const seen = await ctx.database.query<{ id: string }>(
              `SELECT id FROM email_outbox WHERE ticket_id = $1 AND status = 'sent' LIMIT 1`,
              [body.ticketId],
            );
            if (seen[0]) {
              return { queued: false, reason: 'already_replied', outboxId: seen[0].id };
            }
          }
        }
        const id = ulid();
        const status = options.requireApproval ? 'pending_approval' : 'approved';
        await ctx.database.query(
          `INSERT INTO email_outbox
             (id, ticket_id, to_address, subject, body, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            body.ticketId ?? null,
            body.to,
            body.subject,
            body.body,
            status,
            request.actor ?? null,
          ],
        );
        if (!options.requireApproval) await deliver(id);
        return { queued: true, outboxId: id, status };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/emailer/outbox',
      handler: async () => {
        const rows = await ctx.database.query<Record<string, unknown>>(
          `SELECT id, ticket_id, to_address, subject, status, error, message_id, created_at, sent_at
           FROM email_outbox ORDER BY created_at DESC LIMIT 100`,
        );
        return rows.map((row) => ({
          id: row.id,
          ticketId: row.ticket_id,
          to: row.to_address,
          subject: row.subject,
          status: row.status,
          error: row.error,
          messageId: row.message_id,
          createdAt: row.created_at,
          sentAt: row.sent_at,
        }));
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/emailer/outbox/:id/approve',
      handler: async (request) => {
        const rows = await ctx.database.query<{ id: string; status: string }>(
          `SELECT id, status FROM email_outbox WHERE id = $1`,
          [request.params.id],
        );
        if (!rows[0]) throw invalid(`outbox ${request.params.id} not found`);
        if (rows[0].status !== 'pending_approval') {
          throw new AppError(
            'emailer.NOT_PENDING',
            'this email is not waiting for approval',
            undefined,
            409,
          );
        }
        await ctx.database.query(`UPDATE email_outbox SET status = 'approved' WHERE id = $1`, [
          request.params.id,
        ]);
        await deliver(request.params.id);
        return { id: request.params.id, approved: true };
      },
    });

    const deliver = async (id: string): Promise<void> => {
      const rows = await ctx.database.query<Record<string, unknown>>(
        `SELECT id, to_address, subject, body, ticket_id FROM email_outbox WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      if (!row) return;
      if (!smtp) {
        await ctx.database.query(
          `UPDATE email_outbox SET status = 'failed', error = $2 WHERE id = $1`,
          [id, 'SMTP is not configured (EMAIL_SMTP_HOST)'],
        );
        return;
      }
      const messageId = `${Date.now()}.${randomBytes(6).toString('hex')}@triageai`;
      try {
        await sendMail(smtp, {
          to: row.to_address as string,
          subject: row.subject as string,
          body: row.body as string,
          messageId,
        });
        await ctx.database.query(
          `UPDATE email_outbox SET status = 'sent', message_id = $2, sent_at = now() WHERE id = $1`,
          [id, messageId],
        );
        await ctx.database.query(
          `INSERT INTO email_threads (message_id, ticket_id, direction)
           VALUES ($1, $2, 'outbound') ON CONFLICT (message_id) DO NOTHING`,
          [messageId, row.ticket_id ?? null],
        );
      } catch (err) {
        await ctx.database.query(
          `UPDATE email_outbox SET status = 'failed', error = $2 WHERE id = $1`,
          [id, (err as Error).message.slice(0, 500)],
        );
      }
    };

    ctx.events.subscribe('support.ticket.created', async (payload) => {
      const event = payload as { ticketId?: string; emailMessageId?: string };
      if (!event.ticketId || !event.emailMessageId) return;
      await ctx.database.query(
        `INSERT INTO email_threads (message_id, ticket_id, direction)
         VALUES ($1, $2, 'inbound') ON CONFLICT (message_id) DO NOTHING`,
        [event.emailMessageId, event.ticketId],
      );
    });
  },
};
