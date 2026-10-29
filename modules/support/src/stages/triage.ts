/** Triage path stages: load, priority, team, apply (classification comes from ai-pipeline). */
import { ulid } from 'ulid';

import type { TicketPriorityCode } from '@triageai/contracts';
import type { KernelContext } from '@triageai/kernel';

import { assertTransition } from '../state.js';
import type { TicketStatus } from '../state.js';
import { matchPriority, mapTeam } from '../triage.js';
import type { PrioritySignals, TeamMapping } from '../triage.js';
import type { TicketRow } from '../rows.js';
import type { SupportOptions } from '../options.js';

export function registerTriageStages(ctx: KernelContext, options: SupportOptions): void {
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
          priorityCode: ticket.priority_code,
          teamId: ticket.team_id,
          triage: ticket.triage,
          autoReply: ticket.auto_reply,
        },
        evidence: { kind: 'deterministic', ticketId: ticket.id },
        deterministic: { ticketId: ticket.id, status: ticket.status },
      };
    },
  });

  ctx.registerStageHandler('support.triage.priority', {
    execute: async (stage) => {
      const input = stage.input as {
        subject?: string;
        body?: string;
        category?: string | null;
        safetyCritical?: boolean;
      };
      const text = `${input.subject ?? ''}\n\n${input.body ?? ''}`.trim();
      const match = matchPriority(
        text,
        options.triage.prioritySignals as PrioritySignals,
        options.triage.fallbackPriorityCode ?? null,
      );
      const reasons = [...match.reasons];
      if (input.safetyCritical) reasons.push('safety_critical');
      return {
        output: {
          priorityCode: match.priorityCode,
          ambiguous: match.ambiguous,
          reasons,
          matchedLevels: match.matchedLevels,
        },
        evidence: {
          kind: 'deterministic',
          priorityCode: match.priorityCode,
          ambiguous: match.ambiguous,
          matchedLevels: match.matchedLevels,
          reasons,
        },
        deterministic: {
          category: input.category ?? null,
          safetyCritical: Boolean(input.safetyCritical),
          signals: options.triage.prioritySignals,
        },
      };
    },
  });

  ctx.registerStageHandler('support.triage.team', {
    execute: async (stage) => {
      const input = stage.input as {
        category?: string | null;
        priorityCode?: TicketPriorityCode | null;
      };
      const match = mapTeam(
        input.category ?? null,
        input.priorityCode ?? null,
        options.triage.teamMappings as TeamMapping[],
      );
      return {
        output: {
          teamId: match.teamId,
          ambiguous: match.ambiguous,
          reasons: match.reasons,
          candidates: match.candidates,
        },
        evidence: {
          kind: 'deterministic',
          teamId: match.teamId,
          ambiguous: match.ambiguous,
          reasons: match.reasons,
        },
        deterministic: {
          category: input.category ?? null,
          priorityCode: input.priorityCode ?? null,
          mappings: options.triage.teamMappings,
        },
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
        priorityCode?: string | null;
        priorityAmbiguous?: boolean;
        priorityReasons?: string[];
        teamId?: string | null;
        teamAmbiguous?: boolean;
        teamReasons?: string[];
      };
      if (!input.ticketId) throw new Error('support.ticket.apply requires ticketId');

      const rows = await ctx.database.query<TicketRow>(
        `SELECT * FROM support_tickets WHERE id = $1`,
        [input.ticketId],
      );
      const ticket = rows[0];
      if (!ticket) throw new Error(`ticket ${input.ticketId} not found`);

      const triageAmbiguous = Boolean(input.priorityAmbiguous) || Boolean(input.teamAmbiguous);
      const nextStatus: TicketStatus =
        input.escalate || triageAmbiguous ? 'HUMAN_REVIEW' : 'ROUTED';
      assertTransition(ticket.status, nextStatus);

      const triageReasons = [
        ...(input.priorityReasons ?? []),
        ...(input.teamReasons ?? []),
        ...(triageAmbiguous ? ['manual_triage_required'] : []),
      ];
      const classification = {
        category: input.category ?? 'unknown',
        confidence: input.confidence ?? 0,
        margin: input.margin ?? 0,
        method: input.method ?? 'zero-shot',
        modelVersion: input.modelVersion ?? null,
        reasonCodes: [...(input.reasonCodes ?? []), ...triageReasons],
        safetyCritical: Boolean(input.safetyCritical),
      };
      const routing = {
        team: input.team ?? 'human-review',
        priority: input.priority ?? 'normal',
        escalate: Boolean(input.escalate) || triageAmbiguous,
        ruleIds: input.ruleIds ?? [],
        rulesVersion: input.rulesVersion ?? null,
        reasons: input.routeReasons ?? [],
      };
      const triage = {
        priorityCode: input.priorityCode ?? null,
        teamId: input.teamId ?? null,
        ambiguous: triageAmbiguous,
        reasons: triageReasons,
        priorityReasons: input.priorityReasons ?? [],
        teamReasons: input.teamReasons ?? [],
      };

      await ctx.database.query(
        `UPDATE support_tickets
           SET status = $2, category = $3, confidence = $4, margin = $5,
               priority = $6, team = $7, classification = $8, routing = $9,
               priority_code = $10, team_id = $11, triage = $12, updated_at = now()
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
          triage.priorityCode,
          triage.teamId,
          triage,
        ],
      );
      await ctx.database.query(
        `INSERT INTO support_ticket_events (id, ticket_id, type, payload, actor)
         VALUES ($1, $2, 'classified_and_routed', $3, 'system')`,
        [ulid(), input.ticketId, { classification, routing, triage }],
      );
      await ctx.database.query(
        `INSERT INTO support_ticket_messages (id, ticket_id, author_type, author, body, meta)
         VALUES ($1, $2, 'system', 'system', $3, $4)`,
        [
          ulid(),
          input.ticketId,
          `Ticket classified as ${classification.category} (confidence ${classification.confidence.toFixed(2)}) and sent to ${triage.teamId ?? routing.team} at ${triage.priorityCode ?? routing.priority}.`,
          { classification, routing, triage },
        ],
      );

      // Cross-module reactions (integrations) consume this event instead of
      // reading support tables directly (module-contract §4). Best-effort:
      // a broken subscriber must never roll back ticket state.
      try {
        await ctx.events.publish('support.ticket.routed', {
          ticketId: input.ticketId,
          status: nextStatus,
          subject: ticket.subject,
          body: ticket.body,
          requester: ticket.requester,
          category: classification.category,
          confidence: classification.confidence,
          priorityCode: triage.priorityCode,
          teamId: triage.teamId,
          team: routing.team,
          priority: routing.priority,
          safetyCritical: classification.safetyCritical,
          ambiguous: triageAmbiguous,
          reasonCodes: classification.reasonCodes,
        });
      } catch (err) {
        ctx.logger.warn(
          { ticketId: input.ticketId, err: (err as Error).message },
          'support.ticket.routed subscriber failed',
        );
      }
      return {
        output: {
          ticketId: input.ticketId,
          status: nextStatus,
          team: routing.team,
          teamId: triage.teamId,
          priorityCode: triage.priorityCode,
          ambiguous: triageAmbiguous,
        },
        evidence: { kind: 'deterministic', values: { classification, routing, triage } },
        deterministic: {
          from: ticket.status,
          to: nextStatus,
          classification,
          routing,
          triage,
        },
      };
    },
  });
}
