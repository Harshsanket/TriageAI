/** Helpers shared by stages, routes and event subscribers. */
import { createHash } from 'node:crypto';

import { ulid } from 'ulid';

import type { KernelContext } from '@triageai/kernel';

import { assertTransition, canTransition } from './state.js';
import type { TicketStatus } from './state.js';
import type { TicketRow } from './rows.js';

export function createSupportServices(ctx: KernelContext) {
  const hashAnswer = (answer: string): string =>
    createHash('sha256').update(answer.trim()).digest('hex');

  const loadTicketRow = async (id: string): Promise<TicketRow | undefined> => {
    const rows = await ctx.database.query<TicketRow>(
      `SELECT * FROM support_tickets WHERE id = $1`,
      [id],
    );
    return rows[0];
  };

  const escalateAutoReply = async (args: {
    ticketId: string;
    runId?: string | null;
    reasons: string[];
    checks?: unknown;
  }): Promise<{ escalated: boolean; status: string; reasons: string[] }> => {
    const ticket = await loadTicketRow(args.ticketId);
    if (!ticket) throw new Error(`ticket ${args.ticketId} not found`);
    if (ticket.status === 'HUMAN_REVIEW') {
      return { escalated: false, status: ticket.status, reasons: args.reasons };
    }
    if (!canTransition(ticket.status as TicketStatus, 'HUMAN_REVIEW')) {
      return { escalated: false, status: ticket.status, reasons: args.reasons };
    }
    await ctx.database.query(
      `UPDATE support_tickets SET status = 'HUMAN_REVIEW', auto_reply = $2, updated_at = now()
       WHERE id = $1`,
      [
        args.ticketId,
        {
          state: 'escalated',
          runId: args.runId ?? null,
          reasons: args.reasons,
        },
      ],
    );
    await ctx.database.query(
      `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
       VALUES ($1, $2, 'auto_reply_escalated', $3, 'system')`,
      [
        ulid(),
        args.ticketId,
        {
          reasons: args.reasons,
          runId: args.runId ?? null,
          checks: args.checks ?? null,
        },
      ],
    );
    await ctx.database.query(
      `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
       VALUES ($1, $2, 'system', 'system', $3, $4)`,
      [
        ulid(),
        args.ticketId,
        `Auto-reply escalated to human review (${args.reasons.join(', ') || 'policy'}).`,
        {
          kind: 'auto_reply_escalation',
          customerVisible: false,
          reasons: args.reasons,
          runId: args.runId ?? null,
        },
      ],
    );
    return { escalated: true, status: 'HUMAN_REVIEW', reasons: args.reasons };
  };

  async function transitionTicket(id: string, to: string, actor: string, note?: string) {
    const rows = await ctx.database.query<TicketRow>(
      `SELECT id, status FROM support_tickets WHERE id = $1`,
      [id],
    );
    const ticket = rows[0];
    if (!ticket) throw Object.assign(new Error(`ticket ${id} not found`), { statusCode: 404 });
    assertTransition(ticket.status, to);
    await ctx.database.query(
      `UPDATE support_tickets SET status = $2, updated_at = now() WHERE id = $1`,
      [id, to],
    );
    await ctx.database.query(
      `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
       VALUES ($1, $2, 'status_changed', $3, $4)`,
      [ulid(), id, { from: ticket.status, to, note: note ?? null }, actor],
    );
    if (note) {
      await ctx.database.query(
        `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body)
         VALUES ($1, $2, 'agent', $3, $4)`,
        [ulid(), id, actor, note],
      );
    }
    try {
      await ctx.events.publish('support.ticket.status_changed', {
        ticketId: id,
        from: ticket.status,
        to,
        actor,
      });
    } catch (err) {
      ctx.logger.warn(
        { ticketId: id, err: (err as Error).message },
        'support.ticket.status_changed subscriber failed',
      );
    }
    return { ticketId: id, from: ticket.status, to };
  }

  return { hashAnswer, loadTicketRow, escalateAutoReply, transitionTicket };
}

export type SupportServices = ReturnType<typeof createSupportServices>;
