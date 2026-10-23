/**
 * support module (Phase 3): tickets, messages, events, state machine, agent
 * queue. Classification/routing are performed by ai-pipeline stage handlers;
 * this module applies their outputs to its own tables (no cross-module DB).
 */
import { ulid } from 'ulid';
import { z } from 'zod';

import type { TriageModule } from '@triageai/kernel';

import { assertTransition, TICKET_STATUSES, type TicketStatus } from './state.js';

export { TICKET_STATUSES, TICKET_TRANSITIONS, assertTransition, canTransition } from './state.js';
export type { TicketStatus } from './state.js';

const configSchema = z.object({}).strict();

const MIGRATIONS = [
  {
    id: '0001-support-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS support_tickets (
        id TEXT PRIMARY KEY,
        org_id TEXT,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        requester TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'NEW',
        category TEXT,
        confidence REAL,
        margin REAL,
        priority TEXT,
        team TEXT,
        classification JSONB,
        routing JSONB,
        idempotency_key TEXT UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS support_tickets_status ON support_tickets (status, created_at DESC);
      CREATE TABLE IF NOT EXISTS support_ticket_messages (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        author_type TEXT NOT NULL CHECK (author_type IN ('customer','agent','system')),
        author TEXT,
        body TEXT NOT NULL,
        meta JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS support_ticket_events (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload JSONB,
        actor TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
    dropSql:
      'DROP TABLE IF EXISTS support_ticket_events; DROP TABLE IF EXISTS support_ticket_messages; DROP TABLE IF EXISTS support_tickets;',
  },
];

interface TicketRow {
  [key: string]: unknown;
  id: string;
  subject: string;
  body: string;
  requester: string;
  status: string;
  category: string | null;
  confidence: number | null;
  margin: number | null;
  priority: string | null;
  team: string | null;
  classification: Record<string, unknown> | null;
  routing: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const ticketDto = (row: TicketRow) => ({
  id: row.id,
  subject: row.subject,
  body: row.body,
  requester: row.requester,
  status: row.status,
  category: row.category,
  confidence: row.confidence,
  margin: row.margin,
  priority: row.priority,
  team: row.team,
  classification: row.classification,
  routing: row.routing,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

export const supportModule: TriageModule = {
  id: 'support',
  version: '0.1.0',
  capabilities: ['queue', 'eventBus', 'storage'],
  dependsOn: { modules: [{ id: 'ai-pipeline', version: '^0.1.0' }], capabilities: [] },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['support_tickets', 'support_ticket_messages', 'support_ticket_events'],
  manifest: {
    routes: [{ path: '/support', title: 'Support' }],
    nav: [{ label: 'Support', order: 5, path: '/support' }],
    background: [{ query: 'GET /api/v1/support/queue', intervalMs: 15000 }],
  },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: 'tickets + human review queue' }),
  },
  register(ctx) {
    ctx.registerStageHandler('support.ticket.load', {
      execute: async (stage) => {
        const input = stage.input as { ticketId?: string };
        if (!input.ticketId) throw new Error('support.ticket.load requires ticketId');
        const rows = await ctx.database.query<TicketRow>(
          `SELECT * FROM support_tickets WHERE id = $1`,
          [input.ticketId],
        );
        const ticket = rows[0];
        if (!ticket) throw new Error(`ticket ${input.ticketId} not found`);
        return {
          output: {
            ticketId: ticket.id,
            subject: ticket.subject,
            body: ticket.body,
            requester: ticket.requester,
            status: ticket.status,
          },
          evidence: { kind: 'deterministic', ticketId: ticket.id },
          deterministic: { ticketId: ticket.id, status: ticket.status },
        };
      },
    });

    ctx.registerStageHandler('support.ticket.apply', {
      execute: async (stage) => {
        const input = stage.input as {
          ticketId?: string;
          category?: string;
          confidence?: number;
          margin?: number;
          method?: string;
          modelVersion?: string;
          reasonCodes?: string[];
          safetyCritical?: boolean;
          team?: string;
          priority?: string;
          escalate?: boolean;
          ruleIds?: string[];
          rulesVersion?: number;
          routeReasons?: string[];
        };
        if (!input.ticketId) throw new Error('support.ticket.apply requires ticketId');

        const rows = await ctx.database.query<TicketRow>(
          `SELECT id, status FROM support_tickets WHERE id = $1`,
          [input.ticketId],
        );
        const ticket = rows[0];
        if (!ticket) throw new Error(`ticket ${input.ticketId} not found`);

        const nextStatus: TicketStatus = input.escalate ? 'HUMAN_REVIEW' : 'ROUTED';
        assertTransition(ticket.status, nextStatus);

        const classification = {
          category: input.category ?? 'unknown',
          confidence: input.confidence ?? 0,
          margin: input.margin ?? 0,
          method: input.method ?? 'zero-shot',
          modelVersion: input.modelVersion ?? null,
          reasonCodes: input.reasonCodes ?? [],
          safetyCritical: Boolean(input.safetyCritical),
        };
        const routing = {
          team: input.team ?? 'human-review',
          priority: input.priority ?? 'normal',
          escalate: Boolean(input.escalate),
          ruleIds: input.ruleIds ?? [],
          rulesVersion: input.rulesVersion ?? null,
          reasons: input.routeReasons ?? [],
        };

        await ctx.database.query(
          `UPDATE support_tickets
             SET status = $2, category = $3, confidence = $4, margin = $5,
                 priority = $6, team = $7, classification = $8, routing = $9, updated_at = now()
           WHERE id = $1`,
          [
            input.ticketId,
            nextStatus,
            classification.category,
            classification.confidence,
            classification.margin,
            routing.priority,
            routing.team,
            classification,
            routing,
          ],
        );
        await ctx.database.query(
          `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
           VALUES ($1, $2, 'classified_and_routed', $3, 'system')`,
          [ulid(), input.ticketId, { classification, routing }],
        );
        await ctx.database.query(
          `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
           VALUES ($1, $2, 'system', 'system', $3, $4)`,
          [
            ulid(),
            input.ticketId,
            `Ticket classified as ${classification.category} (confidence ${classification.confidence.toFixed(2)}) and sent to ${routing.team}.`,
            { classification, routing },
          ],
        );
        return {
          output: { ticketId: input.ticketId, status: nextStatus, team: routing.team },
          evidence: { kind: 'deterministic', values: { classification, routing } },
          deterministic: { from: ticket.status, to: nextStatus, classification, routing },
        };
      },
    });

    ctx.queue.start({
      id: 'support.triage',
      module: 'support',
      version: '0.1.0',
      trigger: { type: 'endpoint' },
      stages: [
        { id: 'load', kind: 'support.ticket.load', input: { ticketId: '$.ticketId' } },
        {
          id: 'classify',
          kind: 'ai.classify',
          input: {
            subject: '${stages.load.output.subject}',
            body: '${stages.load.output.body}',
          },
          config: {},
        },
        {
          id: 'route',
          kind: 'ai.route',
          input: {
            category: '${stages.classify.output.category}',
            safetyCritical: '${stages.classify.output.safetyCritical}',
            confidence: '${stages.classify.output.confidence}',
          },
        },
        {
          id: 'apply',
          kind: 'support.ticket.apply',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            category: '${stages.classify.output.category}',
            confidence: '${stages.classify.output.confidence}',
            margin: '${stages.classify.output.margin}',
            method: '${stages.classify.output.method}',
            modelVersion: '${stages.classify.output.modelVersion}',
            reasonCodes: '${stages.classify.output.reasonCodes}',
            safetyCritical: '${stages.classify.output.safetyCritical}',
            team: '${stages.route.output.team}',
            priority: '${stages.route.output.priority}',
            escalate: '${stages.route.output.escalate}',
            ruleIds: '${stages.route.output.ruleIds}',
            rulesVersion: '${stages.route.output.rulesVersion}',
            routeReasons: '${stages.route.output.reasons}',
          },
        },
      ],
    });

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

        if (body.idempotencyKey) {
          const existing = await ctx.database.query<TicketRow>(
            `SELECT * FROM support_tickets WHERE idempotency_key = $1`,
            [body.idempotencyKey],
          );
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
          `INSERT INTO support_tickets (id, org_id, subject, body, requester, status, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, 'NEW', $6)`,
          [
            ticketId,
            body.orgId ?? null,
            body.subject,
            body.body,
            body.requester,
            body.idempotencyKey ?? null,
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
        if (!ticket) throw Object.assign(new Error(`ticket ${id} not found`), { statusCode: 404 });
        const messages = await ctx.database.query<{ [key: string]: unknown }>(
          `SELECT id, author_type, author, body, meta, created_at FROM support_ticket_messages
           WHERE ticket_id = $1 ORDER BY created_at`,
          [id],
        );
        const events = await ctx.database.query<{ [key: string]: unknown }>(
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
      return { ticketId: id, from: ticket.status, to };
    }

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
        return transitionTicket(id, body.to, body.actor, body.note);
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
        return transitionTicket(id, 'RESOLVED', body.actor, body.note);
      },
    });
  },
};
