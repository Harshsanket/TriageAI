/** HTTP routes: tickets, confirmation, triage overrides, auto-reply policies. */
import { ulid } from 'ulid';
import { z } from 'zod';

import {
  AutoReplyPolicyUpdateSchema,
  TicketConfirmationRequestSchema,
  TicketConfirmationResponseSchema,
  TicketTriageOverrideRequestSchema,
  TicketTriagePolicyDtoSchema,
} from '@triageai/contracts';
import { AppError } from '@triageai/kernel';
import type { KernelContext } from '@triageai/kernel';

import { TICKET_STATUSES } from './state.js';
import { policyTeamIds, PRIORITY_CODES } from './triage.js';
import type { TeamMapping } from './triage.js';
import { ownedBy, ticketDto, policyDto } from './rows.js';
import type { TicketRow, PolicyRow, AutoReplyRow } from './rows.js';
import type { SupportOptions } from './options.js';
import type { SupportServices } from './services.js';

export function registerRoutes(
  ctx: KernelContext,
  options: SupportOptions,
  svc: SupportServices,
): void {
  const { loadTicketRow, transitionTicket } = svc;
  ctx.registerRoute({
    method: 'POST',
    url: '/api/v1/support/tickets',
    handler: async (request) => {
      const body = z
        .object({
          subject: z.string().min(1).max(300),
          body: z.string().min(1).max(20_000),
          requester: z.string().min(1).max(200).default('customer'),
          idempotencyKey: z.string().min(1).max(200).optional(),
          orgId: z.string().optional(),
        })
        .parse(request.body);
      // A scoped caller (customer) is always the requester; never trust the body.
      if (request.ownerScope !== undefined) body.requester = request.actor ?? body.requester;

      if (body.idempotencyKey) {
        const existing = await ctx.database.query<TicketRow>(
          `SELECT * FROM support_tickets WHERE idempotency_key = $1`,
          [body.idempotencyKey],
        );
        if (existing[0] && !ownedBy(existing[0], request.ownerScope)) {
          // Keys are global; never hand another owner's ticket back.
          throw new AppError('CONFLICT', 'idempotency key already used');
        }
        if (existing[0]) {
          return {
            ticketId: existing[0].id,
            ticket: ticketDto(existing[0]),
            status: existing[0].status,
            runId: null,
            deduped: true,
          };
        }
      }

      const ticketId = ulid();
      await ctx.database.query(
        `INSERT INTO support_tickets
           (id, org_id, subject, body, requester, status, idempotency_key, owner_id)
         VALUES ($1, $2, $3, $4, $5, 'NEW', $6, $7)`,
        [
          ticketId,
          body.orgId ?? null,
          body.subject,
          body.body,
          body.requester,
          body.idempotencyKey ?? null,
          request.actorId ?? null,
        ],
      );
      await ctx.database.query(
        `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body)
         VALUES ($1, $2, 'customer', $3, $4)`,
        [ulid(), ticketId, body.requester, body.body],
      );
      await ctx.database.query(
        `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
         VALUES ($1, $2, 'created', $3, $4)`,
        [ulid(), ticketId, { requester: body.requester }, body.requester],
      );

      const started = await ctx.queue.startWorkflow(
        'support.triage',
        { ticketId },
        { idempotencyKey: `ticket:${ticketId}`, trigger: 'endpoint' },
      );
      return { ticketId, runId: started.runId, status: 'NEW' };
    },
  });

  ctx.registerRoute({
    method: 'GET',
    url: '/api/v1/support/tickets',
    handler: async (request) => {
      const query = request.query as { status?: string; limit?: string };
      const rawLimit = Number(query.limit ?? 25);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 25;
      const rows = await ctx.database.query<TicketRow>(
        `SELECT * FROM support_tickets
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at DESC LIMIT $2`,
        [query.status ?? null, limit],
      );
      return rows.map(ticketDto);
    },
  });

  ctx.registerRoute({
    method: 'GET',
    url: '/api/v1/support/tickets/:id',
    handler: async (request) => {
      const { id } = request.params;
      const rows = await ctx.database.query<TicketRow>(
        `SELECT * FROM support_tickets WHERE id = $1`,
        [id],
      );
      const ticket = rows[0];
      if (!ticket || !ownedBy(ticket, request.ownerScope)) {
        throw new AppError('NOT_FOUND', `ticket ${id} not found`);
      }
      const customerView = request.ownerScope !== undefined;
      // Customers see their own and agent messages plus system messages that
      // were explicitly marked customer-visible; internal events stay hidden.
      const messages = await ctx.database.query<{ [key: string]: unknown }>(
        `SELECT id, author_type, author, body, meta, created_at FROM support_ticket_messages
         WHERE ticket_id = $1
           AND (NOT $2::boolean OR author_type <> 'system' OR meta->>'customerVisible' = 'true')
         ORDER BY created_at`,
        [id, customerView],
      );
      const events = customerView
        ? []
        : await ctx.database.query<{ [key: string]: unknown }>(
            `SELECT id, type, payload, actor, created_at FROM support_ticket_events
             WHERE ticket_id = $1 ORDER BY created_at`,
            [id],
          );
      return {
        ticket: ticketDto(ticket),
        messages: messages.map((message) => ({
          id: message.id,
          authorType: message.author_type,
          author: message.author,
          body: message.body,
          meta: message.meta ?? null,
          createdAt: new Date(message.created_at as string).toISOString(),
        })),
        events: events.map((event) => ({
          id: event.id,
          type: event.type,
          payload: event.payload ?? null,
          actor: event.actor,
          createdAt: new Date(event.created_at as string).toISOString(),
        })),
      };
    },
  });

  ctx.registerRoute({
    method: 'GET',
    url: '/api/v1/support/queue',
    handler: async () => {
      const rows = await ctx.database.query<TicketRow>(
        `SELECT * FROM support_tickets
         WHERE status IN ('ROUTED','HUMAN_REVIEW')
         ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                  created_at ASC
         LIMIT 100`,
      );
      return rows.map(ticketDto);
    },
  });

  ctx.registerRoute({
    method: 'POST',
    url: '/api/v1/support/tickets/:id/transitions',
    handler: async (request) => {
      const { id } = request.params;
      const body = z
        .object({
          to: z.enum(TICKET_STATUSES),
          actor: z.string().min(1).max(200).default('agent'),
          note: z.string().max(5000).optional(),
        })
        .parse(request.body);
      return transitionTicket(id, body.to, request.actor ?? body.actor, body.note);
    },
  });

  ctx.registerRoute({
    method: 'POST',
    url: '/api/v1/support/tickets/:id/resolve',
    handler: async (request) => {
      const { id } = request.params;
      const body = z
        .object({
          actor: z.string().min(1).max(200).default('agent'),
          note: z.string().max(5000).optional(),
        })
        .parse(request.body ?? {});
      return transitionTicket(id, 'RESOLVED', request.actor ?? body.actor, body.note);
    },
  });

  ctx.registerRoute({
    method: 'GET',
    url: '/api/v1/support/triage-policy',
    handler: async () =>
      TicketTriagePolicyDtoSchema.parse({
        priorities: PRIORITY_CODES,
        teamIds: policyTeamIds(options.triage.teamMappings as TeamMapping[]),
        ambiguous: 'unmatched or conflicting priority/team signals go to human review',
      }),
  });

  ctx.registerRoute({
    method: 'PATCH',
    url: '/api/v1/support/tickets/:id/triage',
    handler: async (request) => {
      const { id } = request.params;
      const parsedBody = TicketTriageOverrideRequestSchema.parse(request.body);
      const body = { ...parsedBody, actor: request.actor ?? parsedBody.actor };
      const configuredTeams = new Set(policyTeamIds(options.triage.teamMappings as TeamMapping[]));
      if (!configuredTeams.has(body.teamId)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `team ${body.teamId} is not configured; refusing to fabricate a team id`,
          { teamIds: [...configuredTeams] },
        );
      }
      const ticket = await loadTicketRow(id);
      if (!ticket) throw new AppError('NOT_FOUND', `ticket ${id} not found`);
      if (ticket.status === 'RESOLVED' || ticket.status === 'CANCELLED') {
        throw new AppError('CONFLICT', `ticket ${id} is ${ticket.status}; triage is immutable`);
      }

      const previous = {
        priorityCode: ticket.priority_code,
        teamId: ticket.team_id,
        triage: ticket.triage,
      };
      const triage = {
        ...(ticket.triage ?? {}),
        priorityCode: body.priorityCode,
        teamId: body.teamId,
        ambiguous: false,
        reasons: ['agent_override'],
        overriddenBy: body.actor,
        overriddenAt: new Date().toISOString(),
      };
      const updatedRows = await ctx.database.query<TicketRow>(
        `UPDATE support_tickets
           SET priority_code = $2, team_id = $3, triage = $4, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, body.priorityCode, body.teamId, triage],
      );
      await ctx.database.query(
        `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
         VALUES ($1, $2, 'triage_overridden', $3, $4)`,
        [
          ulid(),
          id,
          {
            previous,
            triage,
            method: body.method,
            note: body.note ?? null,
            status: ticket.status,
          },
          body.actor,
        ],
      );

      // Agent corrections are feedback, never training data: they enter the
      // candidate pool as `proposed` and must be reviewed (FR-6.2).
      const latestRun = await ctx.database.query<{ id: string }>(
        `SELECT id FROM workflow_runs
         WHERE input->>'ticketId' = $1 ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      await ctx.database.query(
        `INSERT INTO candidate_examples
           (id, source, source_run_id, input, gold, provenance, status, actor)
         VALUES ($1, 'agent_override', $2, $3, $4, $5, 'proposed', $6)`,
        [
          ulid(),
          latestRun[0]?.id ?? null,
          { ticketId: id, subject: ticket.subject, body: ticket.body },
          {
            category: ticket.category,
            priorityCode: body.priorityCode,
            teamId: body.teamId,
          },
          {
            ticketId: id,
            previous,
            method: body.method,
            note: body.note ?? null,
            actor: body.actor,
          },
          body.actor,
        ],
      );

      return ticketDto(updatedRows[0] as TicketRow);
    },
  });

  ctx.registerRoute({
    method: 'GET',
    url: '/api/v1/support/auto-reply-policies',
    handler: async () => {
      const rows = await ctx.database.query<PolicyRow>(
        `SELECT DISTINCT ON (category) *
         FROM support_auto_reply_policies
         ORDER BY category, version DESC`,
      );
      return rows.map(policyDto);
    },
  });

  ctx.registerRoute({
    method: 'PUT',
    url: '/api/v1/support/auto-reply-policies/:category',
    handler: async (request) => {
      const { category } = request.params;
      const body = AutoReplyPolicyUpdateSchema.parse(request.body);
      const row = await ctx.database.transaction(async (tx) => {
        await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `support-auto-reply-policy:${category}`,
        ]);
        const current = await tx.query<PolicyRow>(
          `SELECT * FROM support_auto_reply_policies
           WHERE category = $1 ORDER BY version DESC LIMIT 1`,
          [category],
        );
        const latest = current[0];
        const version = (latest?.version ?? 0) + 1;
        const inserted = await tx.query<PolicyRow>(
          `INSERT INTO support_auto_reply_policies
             (category, version, enabled, fallback_policy, collection, max_answer_chars, note, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            category,
            version,
            body.enabled,
            body.fallbackPolicy ?? latest?.fallback_policy ?? 'escalate_human',
            body.collection ?? latest?.collection ?? options.defaultCollection,
            body.maxAnswerChars ?? latest?.max_answer_chars ?? options.defaultMaxAnswerChars,
            body.note ?? latest?.note ?? null,
            body.updatedBy,
          ],
        );
        return inserted[0] as PolicyRow;
      });
      return policyDto(row);
    },
  });

  ctx.registerRoute({
    method: 'POST',
    url: '/api/v1/support/tickets/:id/confirmation',
    handler: async (request) => {
      const { id } = request.params;
      const body = TicketConfirmationRequestSchema.parse(request.body);
      const ticket = await loadTicketRow(id);
      if (!ticket || !ownedBy(ticket, request.ownerScope)) {
        throw new AppError('NOT_FOUND', `ticket ${id} not found`);
      }
      if (ticket.status !== 'AWAITING_CUSTOMER') {
        throw new AppError(
          'CONFLICT',
          `ticket ${id} is ${ticket.status}; only AWAITING_CUSTOMER accepts confirmation`,
        );
      }
      const latest = await ctx.database.query<AutoReplyRow>(
        `SELECT * FROM support_auto_replies
         WHERE ticket_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [id],
      );
      const autoReply = latest[0];
      if (body.note) {
        await ctx.database.query(
          `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body)
           VALUES ($1, $2, 'customer', 'customer', $3)`,
          [ulid(), id, body.note],
        );
      }

      if (body.solved) {
        if (autoReply) {
          await ctx.database.query(
            `UPDATE support_auto_replies SET state = 'confirmed' WHERE id = $1`,
            [autoReply.id],
          );
        }
        await transitionTicket(id, 'RESOLVED', 'customer');
        await ctx.database.query(
          `UPDATE support_tickets SET auto_reply = $2, updated_at = now() WHERE id = $1`,
          [id, { state: 'confirmed', autoReplyId: autoReply?.id ?? null }],
        );
        await ctx.database.query(
          `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
           VALUES ($1, $2, 'customer_confirmed', $3, 'customer')`,
          [ulid(), id, { autoReplyId: autoReply?.id ?? null }],
        );
        // A verified resolution is feedback, never training data: it enters
        // the candidate pool as `proposed` and must be reviewed (FR-6.2).
        if (autoReply) {
          await ctx.database.query(
            `INSERT INTO candidate_examples (id, source, source_run_id, input, gold, provenance, status, actor)
             VALUES ($1, 'confirmed_resolution', $2, $3, $4, $5, 'proposed', 'customer')`,
            [
              ulid(),
              autoReply.run_id,
              { ticketId: id, subject: ticket.subject, body: ticket.body },
              { category: ticket.category, answer: autoReply.answer },
              {
                ticketId: id,
                autoReplyId: autoReply.id,
                method: 'confirmed_resolution',
                actor: 'customer',
              },
            ],
          );
        }
        return TicketConfirmationResponseSchema.parse({
          ticketId: id,
          status: 'RESOLVED',
          autoReplyId: autoReply?.id ?? null,
        });
      }

      if (autoReply) {
        await ctx.database.query(
          `UPDATE support_auto_replies SET state = 'failed', reason = 'customer_still_needs_help' WHERE id = $1`,
          [autoReply.id],
        );
      }
      await transitionTicket(id, 'HUMAN_REVIEW', 'customer');
      await ctx.database.query(
        `UPDATE support_tickets SET auto_reply = $2, updated_at = now() WHERE id = $1`,
        [
          id,
          {
            state: 'failed',
            autoReplyId: autoReply?.id ?? null,
            answerHash: autoReply?.answer_hash ?? null,
            reason: 'customer_still_needs_help',
          },
        ],
      );
      await ctx.database.query(
        `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
         VALUES ($1, $2, 'customer_still_needs_help', $3, 'customer')`,
        [
          ulid(),
          id,
          {
            autoReplyId: autoReply?.id ?? null,
            answerHash: autoReply?.answer_hash ?? null,
            note: body.note ?? null,
          },
        ],
      );
      return TicketConfirmationResponseSchema.parse({
        ticketId: id,
        status: 'HUMAN_REVIEW',
        autoReplyId: autoReply?.id ?? null,
      });
    },
  });

  ctx.registerRoute({
    method: 'POST',
    url: '/api/v1/support/tickets/:id/auto-reply',
    handler: async (request) => {
      const { id } = request.params;
      const ticket = await loadTicketRow(id);
      if (!ticket) throw new AppError('NOT_FOUND', `ticket ${id} not found`);
      if (!['ROUTED', 'AWAITING_CUSTOMER', 'HUMAN_REVIEW'].includes(ticket.status)) {
        throw new AppError(
          'CONFLICT',
          `ticket ${id} is ${ticket.status}; automatic replies are not allowed here`,
        );
      }
      // Manual re-dispatch deliberately omits the per-ticket idempotency key so
      // repeat detection (answer hash) can protect the customer.
      const started = await ctx.queue.startWorkflow(
        'support.auto_reply',
        { ticketId: id },
        { trigger: 'manual' },
      );
      return { ticketId: id, runId: started.runId, deduped: started.deduped };
    },
  });
}
