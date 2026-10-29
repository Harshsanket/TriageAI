/** Event subscribers: GitHub issue sync and auto-reply run failures. */
import { ulid } from 'ulid';

import type { KernelContext } from '@triageai/kernel';

import type { SupportOptions } from './options.js';
import type { SupportServices } from './services.js';

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

  ctx.events.subscribe('workflow.run.finished', async (payload) => {
    const event = payload as {
      runId?: string;
      workflowId?: string;
      status?: string;
      error?: string | null;
      input?: { ticketId?: string };
    };
    if (event.workflowId !== 'support.auto_reply') return;
    if (event.status !== 'FAILED' && event.status !== 'AWAITING') return;
    const ticketId = event.input?.ticketId;
    if (!ticketId) return;
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
