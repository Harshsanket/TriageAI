/**
 * support module (Phase 3): tickets, messages, events, state machine, agent
 * queue. Classification/routing are performed by ai-pipeline stage handlers;
 * this module applies their outputs to its own tables (no cross-module DB).
 *
 * Layout: options · migrations · rows (types + DTOs) · services (shared
 * helpers) · stages/* · workflows · events · routes. See module-contract §6.
 */
import type { TriageModule } from '@triageai/kernel';

import { registerEventSubscribers } from './events.js';
import { MIGRATIONS } from './migrations.js';
import { configSchema } from './options.js';
import { registerRoutes } from './routes.js';
import { createSupportServices } from './services.js';
import { registerAutoReplyStages } from './stages/autoReply.js';
import { registerTriageStages } from './stages/triage.js';
import { registerWorkflows } from './workflows.js';

export { TICKET_STATUSES, TICKET_TRANSITIONS, assertTransition, canTransition } from './state.js';
export type { TicketStatus } from './state.js';
export { matchPriority, mapTeam, PRIORITY_CODES } from './triage.js';
export type { PrioritySignals, TeamMapping } from './triage.js';

export const supportModule: TriageModule = {
  id: 'support',
  version: '0.3.0',
  capabilities: ['queue', 'eventBus', 'storage', 'retriever', 'generator', 'validator'],
  permissions: {
    storage: { schema: true },
    routes: [
      { method: 'GET', path: '/api/v1/support/auto-reply-policies' },
      { method: 'GET', path: '/api/v1/support/canned-responses' },
      { method: 'GET', path: '/api/v1/support/my-tickets' },
      { method: 'GET', path: '/api/v1/support/queue' },
      { method: 'GET', path: '/api/v1/support/sla/breaches' },
      { method: 'GET', path: '/api/v1/support/tickets' },
      { method: 'GET', path: '/api/v1/support/tickets/:id' },
      { method: 'GET', path: '/api/v1/support/triage-policy' },
      { method: 'PATCH', path: '/api/v1/support/tickets/:id/assignment' },
      { method: 'PATCH', path: '/api/v1/support/tickets/:id/triage' },
      { method: 'POST', path: '/api/v1/support/canned-responses' },
      { method: 'POST', path: '/api/v1/support/tickets' },
      { method: 'POST', path: '/api/v1/support/tickets/:id/auto-reply' },
      { method: 'POST', path: '/api/v1/support/tickets/:id/confirmation' },
      { method: 'POST', path: '/api/v1/support/tickets/:id/csat' },
      { method: 'POST', path: '/api/v1/support/tickets/:id/resolve' },
      { method: 'POST', path: '/api/v1/support/tickets/:id/transitions' },
      { method: 'PUT', path: '/api/v1/support/auto-reply-policies/:category' },
    ],
    events: {
      publish: ['support.ticket.created', 'support.ticket.routed', 'support.ticket.status_changed'],
      subscribe: [
        'email.received',
        'email.reply_received',
        'integrations.github.issue_closed',
        'integrations.github.issue_linked',
        'integrations.github.issue_reopened',
        'support.ticket.routed',
        'workflow.run.finished',
      ],
    },
    capabilities: {
      consume: ['queue', 'eventBus', 'storage', 'retriever', 'generator', 'validator'],
      provide: [],
    },
    stages: [
      'support.auto_reply_clarify',
      'support.auto_reply_deliver',
      'support.auto_reply_escalate',
      'support.reply_decision',
      'support.reply_policy',
      'support.ticket.apply',
      'support.ticket.load',
      'support.triage.priority',
      'support.triage.team',
    ],
    workflows: ['support.auto_reply', 'support.triage'],
    evals: [],
    tools: [],
    knowledge: { read: ['*'], write: [] },
  },
  dependsOn: {
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
    'support_canned_responses',
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
    const svc = createSupportServices(ctx);

    registerTriageStages(ctx, options);
    registerAutoReplyStages(ctx, options, svc);
    registerEventSubscribers(ctx, options, svc);
    registerWorkflows(ctx);
    registerRoutes(ctx, options, svc);

    ctx.registerRetentionTask({
      id: 'support.messages',
      apply: async ({ database, cutoffs }) => {
        if (!cutoffs.messages) return 0;
        const rows = await database.query(
          `DELETE FROM support_ticket_messages WHERE created_at < $1 RETURNING id`,
          [cutoffs.messages],
        );
        return rows.length;
      },
    });
  },
};
