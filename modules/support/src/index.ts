/**
 * support module (Phase 3): tickets, messages, events, state machine, agent
 * queue. Classification/routing are performed by ai-pipeline stage handlers;
 * this module applies their outputs to its own tables (no cross-module DB).
 */
import { createHash } from 'node:crypto';

import { ulid } from 'ulid';
import { z } from 'zod';

import {
  AutoReplyPolicyDtoSchema,
  AutoReplyPolicyUpdateSchema,
  TicketConfirmationRequestSchema,
  TicketConfirmationResponseSchema,
} from '@triageai/contracts';
import { AppError } from '@triageai/kernel';
import type { TriageModule } from '@triageai/kernel';

import { assertTransition, canTransition, TICKET_STATUSES, type TicketStatus } from './state.js';

export { TICKET_STATUSES, TICKET_TRANSITIONS, assertTransition, canTransition } from './state.js';
export type { TicketStatus } from './state.js';

const configSchema = z
  .object({
    defaultMaxAnswerChars: z.number().int().positive().max(20_000).default(1200),
    defaultCollection: z.string().default('kb_docs'),
  })
  .strict();

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
  {
    id: '0002-support-auto-reply',
    sql: `
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS auto_reply JSONB;

      CREATE TABLE IF NOT EXISTS support_auto_reply_policies (
        category TEXT NOT NULL,
        version INT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        fallback_policy TEXT NOT NULL DEFAULT 'escalate_human'
          CHECK (fallback_policy IN ('request_clarification','return_uncertain','escalate_human','halt_run','retry_alternative_retrieval')),
        collection TEXT NOT NULL DEFAULT 'kb_docs',
        max_answer_chars INT NOT NULL DEFAULT 1200,
        note TEXT,
        updated_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (category, version)
      );

      CREATE TABLE IF NOT EXISTS support_auto_replies (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        run_id TEXT,
        answer TEXT NOT NULL,
        answer_hash TEXT NOT NULL,
        citations JSONB NOT NULL DEFAULT '[]'::jsonb,
        state TEXT NOT NULL CHECK (state IN ('sent','confirmed','failed','escalated')),
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS support_auto_replies_ticket
        ON support_auto_replies (ticket_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS support_auto_replies_failed_hash
        ON support_auto_replies (ticket_id, state, answer_hash);

      INSERT INTO support_auto_reply_policies
        (category, version, enabled, fallback_policy, note)
      VALUES
        ('known_troubleshooting', 1, true, 'request_clarification', 'phase-5 seed'),
        ('billing', 1, true, 'escalate_human', 'phase-5 seed'),
        ('account', 1, true, 'escalate_human', 'phase-5 seed'),
        ('feature_question', 1, true, 'request_clarification', 'phase-5 seed'),
        ('general_question', 1, true, 'request_clarification', 'phase-5 seed'),
        ('security', 1, false, 'escalate_human', 'safety-critical: never auto-reply'),
        ('bug_report', 1, false, 'escalate_human', 'manual triage first'),
        ('refund_dispute', 1, false, 'escalate_human', 'manual triage first')
      ON CONFLICT (category, version) DO NOTHING;
    `,
    dropSql:
      'DROP TABLE IF EXISTS support_auto_replies; DROP TABLE IF EXISTS support_auto_reply_policies;',
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
  auto_reply: Record<string, unknown> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface PolicyRow {
  [key: string]: unknown;
  category: string;
  version: number;
  enabled: boolean;
  fallback_policy: string;
  collection: string;
  max_answer_chars: number;
  note: string | null;
  updated_by: string | null;
  created_at: Date | string;
}

interface AutoReplyRow {
  [key: string]: unknown;
  id: string;
  ticket_id: string;
  run_id: string | null;
  answer: string;
  answer_hash: string;
  citations: string[] | null;
  state: string;
  reason: string | null;
  created_at: Date | string;
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
  autoReply: row.auto_reply ?? null,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

export const supportModule: TriageModule = {
  id: 'support',
  version: '0.2.0',
  capabilities: ['queue', 'eventBus', 'storage', 'retriever', 'generator', 'validator'],
  dependsOn: {
    modules: [{ id: 'ai-pipeline', version: '^0.1.0' }],
    capabilities: [
      { capability: 'retriever', optional: true },
      { capability: 'generator', optional: true },
      { capability: 'validator', optional: true },
    ],
  },
  configSchema,
  migrations: MIGRATIONS,
  tables: [
    'support_tickets',
    'support_ticket_messages',
    'support_ticket_events',
    'support_auto_reply_policies',
    'support_auto_replies',
  ],
  manifest: {
    routes: [{ path: '/support', title: 'Support' }],
    nav: [{ label: 'Support', order: 5, path: '/support' }],
    background: [{ query: 'GET /api/v1/support/queue', intervalMs: 15000 }],
  },
  lifecycle: {
    health: async () => ({
      status: 'healthy',
      detail: 'tickets + auto-reply + human review queue',
    }),
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});

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
            category: ticket.category,
            team: ticket.team,
            priority: ticket.priority,
            autoReply: ticket.auto_reply,
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

    ctx.registerStageHandler('support.reply_policy', {
      execute: async (stage) => {
        const input = stage.input as { category?: string | null; ticketId?: string };
        const category = input.category ?? null;
        const retriever = ctx.capabilities.retriever;
        const generator = ctx.capabilities.generator;
        const missingCapabilities = !retriever || !generator;

        if (!category) {
          return {
            output: {
              category: null,
              enabled: false,
              reason: 'category_missing',
              fallbackPolicy: 'escalate_human',
              collection: options.defaultCollection,
              policyVersion: null,
              validationPolicy: { maxChars: options.defaultMaxAnswerChars },
            },
            evidence: { kind: 'deterministic', reason: 'category_missing' },
            deterministic: { enabled: false, reason: 'category_missing' },
          };
        }

        const rows = await ctx.database.query<PolicyRow>(
          `SELECT * FROM support_auto_reply_policies
           WHERE category = $1 ORDER BY version DESC LIMIT 1`,
          [category],
        );
        const policy = rows[0];
        const reason = !policy ? 'no_policy' : missingCapabilities ? 'capabilities_missing' : null;
        const enabled = Boolean(policy?.enabled) && !missingCapabilities;
        const fallbackPolicy = policy?.fallback_policy ?? 'escalate_human';
        const collection = policy?.collection ?? options.defaultCollection;
        const maxChars = policy?.max_answer_chars ?? options.defaultMaxAnswerChars;

        return {
          output: {
            category,
            enabled,
            reason,
            fallbackPolicy,
            collection,
            policyVersion: policy?.version ?? null,
            validationPolicy: { maxChars, groundingThreshold: 0.6 },
          },
          evidence: {
            kind: 'deterministic',
            category,
            policyVersion: policy?.version ?? null,
            enabled,
            reason,
          },
          deterministic: {
            policyRow: policy ?? null,
            capabilities: { retriever: Boolean(retriever), generator: Boolean(generator) },
          },
        };
      },
    });

    ctx.registerStageHandler('support.reply_decision', {
      execute: async (stage) => {
        const input = stage.input as {
          ticketId?: string;
          enabled?: boolean;
          fallbackPolicy?: string;
          sufficient?: boolean;
          generated?: unknown;
          passed?: boolean;
          checks?: Array<{ checkId: string; passed: boolean; reasons: string[] }>;
          answer?: string;
        };
        const reasons: string[] = [];
        let action: 'none' | 'reply' | 'clarify' | 'escalate' = 'none';

        if (!input.enabled) {
          reasons.push('auto_reply_disabled');
        } else if (!input.sufficient) {
          action = 'escalate';
          reasons.push('insufficient_retrieval');
        } else if (!input.generated) {
          action = 'escalate';
          reasons.push('generation_failed');
        } else if (!input.passed) {
          const failed = (input.checks ?? [])
            .filter((check) => !check.passed)
            .flatMap((check) =>
              check.reasons.length > 0 ? check.reasons : [`${check.checkId}_failed`],
            );
          reasons.push(...(failed.length > 0 ? failed : ['validation_failed']));
          action = input.fallbackPolicy === 'request_clarification' ? 'clarify' : 'escalate';
        } else {
          action = 'reply';
        }

        const answer = input.answer?.trim() ?? '';
        const answerHash = answer ? hashAnswer(answer) : null;

        if (action === 'reply' && input.ticketId && answerHash) {
          const repeated = await ctx.database.query<{ id: string }>(
            `SELECT id FROM support_auto_replies
             WHERE ticket_id = $1 AND state = 'failed' AND answer_hash = $2 LIMIT 1`,
            [input.ticketId, answerHash],
          );
          if (repeated[0]) {
            action = 'escalate';
            reasons.push('repeat_answer');
          }
        }

        return {
          output: { action, reasons, answerHash },
          evidence: { kind: 'deterministic', action, reasons },
          deterministic: {
            enabled: Boolean(input.enabled),
            sufficient: Boolean(input.sufficient),
            generated: Boolean(input.generated),
            validationPassed: input.passed ?? null,
          },
          fallback:
            action === 'reply' || action === 'none'
              ? null
              : {
                  policyApplied: input.fallbackPolicy ?? 'escalate_human',
                  action,
                  reasons,
                },
        };
      },
    });

    ctx.registerStageHandler('support.auto_reply_deliver', {
      execute: async (stage) => {
        const input = stage.input as {
          ticketId?: string;
          answer?: string;
          citations?: string[];
          policyVersion?: number | null;
          answerHash?: string;
        };
        if (!input.ticketId || !input.answer) {
          throw new Error('support.auto_reply_deliver requires ticketId + answer');
        }
        const existing = await ctx.database.query<AutoReplyRow>(
          `SELECT * FROM support_auto_replies WHERE run_id = $1 AND ticket_id = $2 LIMIT 1`,
          [stage.runId, input.ticketId],
        );
        if (existing[0]) {
          return {
            output: {
              delivered: true,
              autoReplyId: existing[0].id,
              answerHash: existing[0].answer_hash,
              status: 'AWAITING_CUSTOMER',
              deduped: true,
            },
            evidence: { kind: 'deterministic', autoReplyId: existing[0].id, deduped: true },
            deterministic: { deduped: true },
          };
        }
        const ticket = await loadTicketRow(input.ticketId);
        if (!ticket) throw new Error(`ticket ${input.ticketId} not found`);
        assertTransition(ticket.status, 'AWAITING_CUSTOMER');

        const answerHash = input.answerHash ?? hashAnswer(input.answer);
        const autoReplyId = ulid();
        await ctx.database.query(
          `INSERT INTO support_auto_replies
             (id, ticket_id, run_id, answer, answer_hash, citations, state)
           VALUES ($1, $2, $3, $4, $5, $6, 'sent')`,
          [
            autoReplyId,
            input.ticketId,
            stage.runId,
            input.answer,
            answerHash,
            input.citations ?? [],
          ],
        );
        const messageId = ulid();
        await ctx.database.query(
          `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
           VALUES ($1, $2, 'system', 'system', $3, $4)`,
          [
            messageId,
            input.ticketId,
            input.answer,
            {
              kind: 'auto_reply',
              autoReplyId,
              runId: stage.runId,
              citations: input.citations ?? [],
              answerHash,
              customerVisible: true,
            },
          ],
        );
        await ctx.database.query(
          `UPDATE support_tickets SET status = 'AWAITING_CUSTOMER', auto_reply = $2, updated_at = now()
           WHERE id = $1`,
          [
            input.ticketId,
            {
              state: 'awaiting_customer',
              autoReplyId,
              runId: stage.runId,
              answerHash,
              policyVersion: input.policyVersion ?? null,
            },
          ],
        );
        await ctx.database.query(
          `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
           VALUES ($1, $2, 'auto_reply_sent', $3, 'system')`,
          [
            ulid(),
            input.ticketId,
            {
              autoReplyId,
              runId: stage.runId,
              citations: input.citations ?? [],
              policyVersion: input.policyVersion ?? null,
            },
          ],
        );

        return {
          output: {
            delivered: true,
            autoReplyId,
            messageId,
            answerHash,
            status: 'AWAITING_CUSTOMER',
          },
          evidence: {
            kind: 'model_generated',
            autoReplyId,
            messageId,
            citations: input.citations ?? [],
          },
          deterministic: {
            from: ticket.status,
            to: 'AWAITING_CUSTOMER',
            answerHash,
            policyVersion: input.policyVersion ?? null,
          },
        };
      },
    });

    ctx.registerStageHandler('support.auto_reply_clarify', {
      execute: async (stage) => {
        const input = stage.input as { ticketId?: string; reasons?: string[] };
        if (!input.ticketId) throw new Error('support.auto_reply_clarify requires ticketId');
        const existing = await ctx.database.query<{ id: string }>(
          `SELECT id FROM support_ticket_events
           WHERE ticket_id = $1 AND type = 'auto_reply_clarification'
             AND payload->>'runId' = $2 LIMIT 1`,
          [input.ticketId, stage.runId],
        );
        if (existing[0]) {
          return {
            output: { clarified: true, status: 'AWAITING_CUSTOMER', deduped: true },
            evidence: { kind: 'deterministic', deduped: true },
            deterministic: { deduped: true },
          };
        }
        const ticket = await loadTicketRow(input.ticketId);
        if (!ticket) throw new Error(`ticket ${input.ticketId} not found`);
        assertTransition(ticket.status, 'AWAITING_CUSTOMER');

        const body =
          'Could you share a bit more detail (product, steps, and what you expected) so I can answer precisely?';
        const messageId = ulid();
        await ctx.database.query(
          `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
           VALUES ($1, $2, 'system', 'system', $3, $4)`,
          [
            messageId,
            input.ticketId,
            body,
            {
              kind: 'auto_reply_clarification',
              customerVisible: true,
              reasons: input.reasons ?? [],
              runId: stage.runId,
            },
          ],
        );
        await ctx.database.query(
          `UPDATE support_tickets SET status = 'AWAITING_CUSTOMER', auto_reply = $2, updated_at = now()
           WHERE id = $1`,
          [
            input.ticketId,
            {
              state: 'awaiting_customer',
              kind: 'clarification',
              reasons: input.reasons ?? [],
              runId: stage.runId,
            },
          ],
        );
        await ctx.database.query(
          `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
           VALUES ($1, $2, 'auto_reply_clarification', $3, 'system')`,
          [ulid(), input.ticketId, { reasons: input.reasons ?? [], runId: stage.runId }],
        );

        return {
          output: { clarified: true, messageId, status: 'AWAITING_CUSTOMER' },
          evidence: { kind: 'deterministic', messageId, reasons: input.reasons ?? [] },
          deterministic: { from: ticket.status, to: 'AWAITING_CUSTOMER' },
        };
      },
    });

    ctx.registerStageHandler('support.auto_reply_escalate', {
      execute: async (stage) => {
        const input = stage.input as {
          ticketId?: string;
          reasons?: string[];
          checks?: unknown;
        };
        if (!input.ticketId) throw new Error('support.auto_reply_escalate requires ticketId');
        const result = await escalateAutoReply({
          ticketId: input.ticketId,
          runId: stage.runId,
          reasons: input.reasons ?? ['escalated'],
          checks: input.checks,
        });
        return {
          output: result,
          evidence: { kind: 'deterministic', reasons: result.reasons },
          deterministic: { escalated: result.escalated, status: result.status },
        };
      },
    });

    ctx.registerStageHandler('support.dispatch_auto_reply', {
      execute: async (stage) => {
        const input = stage.input as { ticketId?: string };
        if (!input.ticketId) throw new Error('support.dispatch_auto_reply requires ticketId');
        const started = await stage.queue.startWorkflow(
          'support.auto_reply',
          { ticketId: input.ticketId },
          { idempotencyKey: `auto_reply:${input.ticketId}`, trigger: 'endpoint' },
        );
        return {
          output: { runId: started.runId, deduped: started.deduped },
          evidence: { kind: 'deterministic', runId: started.runId },
          deterministic: { deduped: started.deduped },
        };
      },
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
        {
          id: 'dispatch',
          kind: 'support.dispatch_auto_reply',
          when: "${stages.apply.output.status} == 'ROUTED'",
          input: { ticketId: '${stages.load.output.ticketId}' },
        },
      ],
    });

    ctx.queue.start({
      id: 'support.auto_reply',
      module: 'support',
      version: '0.2.0',
      trigger: { type: 'endpoint' },
      fallbackPolicyId: 'escalate_human',
      stages: [
        {
          id: 'load',
          kind: 'support.ticket.load',
          input: { ticketId: '$.ticketId' },
        },
        {
          id: 'policy',
          kind: 'support.reply_policy',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            category: '${stages.load.output.category}',
          },
        },
        {
          id: 'retrieve',
          kind: 'ai.retrieve',
          when: '${stages.policy.output.enabled}',
          input: {
            query: '${stages.load.output.body}',
            collection: '${stages.policy.output.collection}',
            filter: { approved: true },
          },
        },
        {
          id: 'generate',
          kind: 'ai.generate',
          when: '${stages.retrieve.output.sufficient}',
          input: {
            question: '${stages.load.output.body}',
            chunks: '${stages.retrieve.output.chunks}',
            style: 'assistant',
          },
          retry: { attempts: 2, backoffMs: [100] },
          onError: 'fallback',
        },
        {
          id: 'validate',
          kind: 'ai.validate',
          when: '${stages.generate.output.answer}',
          input: {
            answer: '${stages.generate.output.answer}',
            question: '${stages.load.output.body}',
            sources: '${stages.retrieve.output.chunks}',
            policy: '${stages.policy.output.validationPolicy}',
          },
        },
        {
          id: 'finalize',
          kind: 'ai.finalize_answer',
          when: '${stages.validate.output.passed}',
          input: {
            answer: '${stages.generate.output.answer}',
            sources: '${stages.retrieve.output.chunks}',
          },
        },
        {
          id: 'decision',
          kind: 'support.reply_decision',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            enabled: '${stages.policy.output.enabled}',
            fallbackPolicy: '${stages.policy.output.fallbackPolicy}',
            sufficient: '${stages.retrieve.output.sufficient}',
            generated: '${stages.generate.output.answer}',
            passed: '${stages.validate.output.passed}',
            checks: '${stages.validate.output.checks}',
            answer: '${stages.finalize.output.answer}',
          },
        },
        {
          id: 'deliver',
          kind: 'support.auto_reply_deliver',
          when: "${stages.decision.output.action} == 'reply'",
          input: {
            ticketId: '${stages.load.output.ticketId}',
            answer: '${stages.finalize.output.answer}',
            citations: '${stages.finalize.output.citations}',
            answerHash: '${stages.decision.output.answerHash}',
            policyVersion: '${stages.policy.output.policyVersion}',
          },
        },
        {
          id: 'clarify',
          kind: 'support.auto_reply_clarify',
          when: "${stages.decision.output.action} == 'clarify'",
          input: {
            ticketId: '${stages.load.output.ticketId}',
            reasons: '${stages.decision.output.reasons}',
          },
        },
        {
          id: 'escalate',
          kind: 'support.auto_reply_escalate',
          when: "${stages.decision.output.action} == 'escalate'",
          input: {
            ticketId: '${stages.load.output.ticketId}',
            reasons: '${stages.decision.output.reasons}',
            checks: '${stages.validate.output.checks}',
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

    const policyDto = (row: PolicyRow) =>
      AutoReplyPolicyDtoSchema.parse({
        category: row.category,
        version: row.version,
        enabled: row.enabled,
        fallbackPolicy: row.fallback_policy,
        collection: row.collection,
        maxAnswerChars: row.max_answer_chars,
        note: row.note,
        updatedBy: row.updated_by,
        createdAt: new Date(row.created_at).toISOString(),
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
        if (!ticket) throw new AppError('NOT_FOUND', `ticket ${id} not found`);
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
  },
};
