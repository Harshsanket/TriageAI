/** Event subscribers: GitHub issue sync and auto-reply run failures. */
import { ulid } from 'ulid';

import type { KernelContext } from '@triageai/kernel';

import type { SupportOptions } from './options.js';
import type { SupportServices } from './services.js';
import { canTransition, type TicketStatus } from './state.js';

export function registerEventSubscribers(
  ctx: KernelContext,
  options: SupportOptions,
  svc: SupportServices,
): void {
  const { loadTicketRow, escalateAutoReply, transitionTicket } = svc;
  ctx.events.subscribe('integrations.github.issue_closed', async (payload) => {
    const event = payload as { ticketId?: string; ref?: string; actor?: string };
    if (!event.ticketId) return;
    const ticket = await loadTicketRow(event.ticketId);
    if (!ticket) return;
    if (ticket.status === 'RESOLVED' || ticket.status === 'CANCELLED') {
      await ctx.database.query(
        `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
         VALUES ($1, $2, 'integration_sync_ignored', $3, $4)`,
        [
          ulid(),
          event.ticketId,
          {
            source: 'github',
            ref: event.ref ?? null,
            reason: `ticket_${ticket.status.toLowerCase()}`,
          },
          event.actor ?? 'github',
        ],
      );
      return;
    }
    await transitionTicket(
      event.ticketId,
      'RESOLVED',
      event.actor ?? 'github',
      `Closed via linked GitHub issue ${event.ref ?? ''}`.trim(),
    );
  });

  ctx.events.subscribe('integrations.github.issue_reopened', async (payload) => {
    const event = payload as { ticketId?: string; ref?: string; actor?: string };
    if (!event.ticketId) return;
    const ticket = await loadTicketRow(event.ticketId);
    if (!ticket) return;
    if (ticket.status === 'RESOLVED' || ticket.status === 'CANCELLED') {
      await ctx.database.query(
        `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
         VALUES ($1, $2, 'integration_sync_conflict', $3, $4)`,
        [
          ulid(),
          event.ticketId,
          {
            source: 'github',
            ref: event.ref ?? null,
            reason: 'reopen_requires_manual_ticket',
            ticketStatus: ticket.status,
          },
          event.actor ?? 'github',
        ],
      );
    }
  });

  ctx.events.subscribe('integrations.github.issue_linked', async (payload) => {
    const event = payload as {
      ticketId?: string;
      ref?: string;
      url?: string;
      reason?: string;
      actor?: string;
    };
    if (!event.ticketId || !event.ref) return;
    const existing = await ctx.database.query<{ id: string }>(
      `SELECT id FROM support_ticket_events
       WHERE ticket_id = $1 AND type = 'integration_issue_linked'
         AND payload->>'ref' = $2 LIMIT 1`,
      [event.ticketId, event.ref],
    );
    if (existing[0]) return;
    await ctx.database.query(
      `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
       VALUES ($1, $2, 'integration_issue_linked', $3, $4)`,
      [
        ulid(),
        event.ticketId,
        {
          source: 'github',
          ref: event.ref,
          url: event.url ?? null,
          reason: event.reason ?? null,
        },
        event.actor ?? 'system',
      ],
    );
    await ctx.database.query(
      `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
       VALUES ($1, $2, 'system', 'system', $3, $4)`,
      [
        ulid(),
        event.ticketId,
        `Linked GitHub issue: ${event.url ?? event.ref}`,
        {
          kind: 'integration_link',
          source: 'github',
          ref: event.ref,
          url: event.url ?? null,
          customerVisible: false,
        },
      ],
    );
  });

  ctx.events.subscribe('support.ticket.routed', async (payload) => {
    const event = payload as { ticketId?: string; status?: string };
    if (!event.ticketId || event.status !== 'ROUTED') return;
    try {
      await ctx.queue.startWorkflow(
        'support.auto_reply',
        { ticketId: event.ticketId },
        { idempotencyKey: `auto_reply:${event.ticketId}`, trigger: 'event' },
      );
    } catch (err) {
      ctx.logger.error(
        { ticketId: event.ticketId, err: (err as Error).message },
        'failed to dispatch auto-reply',
      );
    }
  });

  ctx.events.subscribe('email.received', async (payload) => {
    const event = payload as {
      messageId?: string;
      from?: string;
      subject?: string;
      text?: string;
    };
    if (!event.messageId || !event.from || !event.text) return;
    const ticketId = ulid();
    try {
      await ctx.database.query(
        `INSERT INTO support_tickets
           (id, subject, body, requester, status, idempotency_key)
         VALUES ($1, $2, $3, $4, 'NEW', $5)`,
        [
          ticketId,
          (event.subject ?? '(no subject)').slice(0, 300),
          event.text.slice(0, 20_000),
          event.from,
          `email:${event.messageId}`,
        ],
      );
      await ctx.database.query(
        `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
         VALUES ($1, $2, 'customer', $3, $4, $5)`,
        [
          ulid(),
          ticketId,
          event.from,
          event.text.slice(0, 20_000),
          { kind: 'email', messageId: event.messageId },
        ],
      );
      await ctx.database.query(
        `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
         VALUES ($1, $2, 'created', $3, 'email')`,
        [ulid(), ticketId, { requester: event.from, source: 'email' }],
      );
      await ctx.events.publish('support.ticket.created', {
        ticketId,
        requester: event.from,
        subject: event.subject ?? null,
        emailMessageId: event.messageId,
      });
      await ctx.queue.startWorkflow(
        'support.triage',
        { ticketId },
        { trigger: 'event', idempotencyKey: `email:${event.messageId}` },
      );
    } catch (err) {
      ctx.logger.error(
        { messageId: event.messageId, err: (err as Error).message },
        'failed to create ticket from email',
      );
    }
  });

  ctx.events.subscribe('email.reply_received', async (payload) => {
    const event = payload as {
      ticketId?: string;
      messageId?: string;
      from?: string;
      text?: string;
    };
    if (!event.ticketId || !event.text) return;
    const ticket = await loadTicketRow(event.ticketId);
    if (!ticket) return;
    await ctx.database.query(
      `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
       VALUES ($1, $2, 'customer', $3, $4, $5)`,
      [
        ulid(),
        event.ticketId,
        event.from ?? ticket.requester,
        event.text.slice(0, 20_000),
        { kind: 'email', messageId: event.messageId ?? null },
      ],
    );
    if (ticket.status !== 'RESOLVED' && ticket.status !== 'CANCELLED') {
      if (canTransition(ticket.status as TicketStatus, 'HUMAN_REVIEW')) {
        await transitionTicket(
          event.ticketId,
          'HUMAN_REVIEW',
          event.from ?? 'email',
          'email reply',
        );
      }
    }
  });

  ctx.events.subscribe('workflow.run.finished', async (payload) => {
    const event = payload as {
      runId?: string;
      workflowId?: string;
      status?: string;
      error?: string | null;
      input?: { ticketId?: string };
    };
    if (event.status !== 'FAILED' && event.status !== 'AWAITING') return;
    const ticketId = event.input?.ticketId;
    if (!ticketId) return;

    if (event.workflowId === 'support.triage') {
      try {
        const ticket = await loadTicketRow(ticketId);
        if (!ticket || ticket.status === 'HUMAN_REVIEW') return;
        if (!canTransition(ticket.status as TicketStatus, 'HUMAN_REVIEW')) return;
        const reasons = [event.error ?? event.status ?? 'triage_failed'];
        await ctx.database.query(
          `UPDATE support_tickets SET status = 'HUMAN_REVIEW', updated_at = now() WHERE id = $1`,
          [ticketId],
        );
        await ctx.database.query(
          `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
           VALUES ($1, $2, 'triage_escalated', $3, 'system')`,
          [ulid(), ticketId, { reasons, runId: event.runId ?? null }],
        );
        await ctx.database.query(
          `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
           VALUES ($1, $2, 'system', 'system', $3, $4)`,
          [
            ulid(),
            ticketId,
            'Automatic triage is unavailable; this ticket is waiting for a person.',
            {
              kind: 'triage_escalation',
              customerVisible: false,
              reasons,
              runId: event.runId ?? null,
            },
          ],
        );
      } catch (err) {
        ctx.logger.error(
          { ticketId, err: (err as Error).message },
          'failed to escalate triage run',
        );
      }
      return;
    }

    if (event.workflowId !== 'support.auto_reply') return;
    try {
      await escalateAutoReply({
        ticketId,
        runId: event.runId ?? null,
        reasons: [event.error ?? event.status ?? 'run_failed'],
      });
    } catch (err) {
      ctx.logger.error(
        { ticketId, err: (err as Error).message },
        'failed to escalate auto-reply run',
      );
    }
  });
}
