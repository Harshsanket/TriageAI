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
