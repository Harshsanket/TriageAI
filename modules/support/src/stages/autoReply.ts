/** Auto-reply path stages: policy, decision, deliver, clarify, escalate, dispatch. */
import { ulid } from 'ulid';

import type { KernelContext } from '@triageai/kernel';

import { assertTransition } from '../state.js';
import type { PolicyRow, AutoReplyRow } from '../rows.js';
import type { SupportOptions } from '../options.js';
import type { SupportServices } from '../services.js';

export function registerAutoReplyStages(
  ctx: KernelContext,
  options: SupportOptions,
  svc: SupportServices,
): void {
  const { hashAnswer, loadTicketRow, escalateAutoReply } = svc;
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
        [autoReplyId, input.ticketId, stage.runId, input.answer, answerHash, input.citations ?? []],
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

  // Inbound integration sync: GitHub is authoritative for its issue state,
  // but ticket state stays owned by support (acyclic machine). Closed issues
  // resolve active tickets; reopening a resolved ticket is a recorded
  // conflict, never an illegal transition.
}
