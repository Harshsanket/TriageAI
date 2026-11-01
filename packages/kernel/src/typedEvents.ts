/**
 * Typed event registry (ADR-0055 §4): publishers own `<module>.*`, every event
 * has a registered payload schema, and subscribers need a grant. The registry
 * is populated by the core and extended only through `ctx.registerEventSchema`.
 */
import { z } from 'zod';

import { invalid, policyBlocked } from './errors.js';

export interface TypedEvent {
  name: string;
  owner: string;
  schema: z.ZodTypeAny;
}

const object = z.record(z.string(), z.unknown());

/** First-party event shapes; module-owned events register their own schema. */
export const CORE_EVENT_SCHEMAS: TypedEvent[] = [
  {
    name: 'workflow.run.finished',
    owner: 'kernel',
    schema: z
      .object({
        runId: z.string().optional(),
        workflowId: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough(),
  },
  { name: 'kernel.module.started', owner: 'kernel', schema: object },
  {
    name: 'support.ticket.created',
    owner: 'support',
    schema: z.object({ ticketId: z.string() }).passthrough(),
  },
  {
    name: 'support.ticket.routed',
    owner: 'support',
    schema: z.object({ ticketId: z.string() }).passthrough(),
  },
  {
    name: 'support.ticket.status_changed',
    owner: 'support',
    schema: z.object({ ticketId: z.string() }).passthrough(),
  },
  {
    name: 'email.received',
    owner: 'emailer',
    schema: z
      .object({ messageId: z.string().optional(), subject: z.string().optional() })
      .passthrough(),
  },
  {
    name: 'email.reply_received',
    owner: 'emailer',
    schema: z.object({ messageId: z.string().optional() }).passthrough(),
  },
  {
    name: 'integrations.github.issue_linked',
    owner: 'integrations-github',
    schema: object,
  },
  {
    name: 'integrations.github.issue_closed',
    owner: 'integrations-github',
    schema: object,
  },
  {
    name: 'integrations.github.issue_reopened',
    owner: 'integrations-github',
    schema: object,
  },
  {
    name: 'kb.source.ingested',
    owner: 'kb',
    schema: z.object({ sourceId: z.string().optional() }).passthrough(),
  },
];

export class EventSchemaRegistry {
  private readonly events = new Map<string, TypedEvent>();

  constructor(initial: TypedEvent[] = CORE_EVENT_SCHEMAS) {
    for (const event of initial) this.events.set(event.name, event);
  }

  register(event: TypedEvent): void {
    const existing = this.events.get(event.name);
    if (existing && existing.owner !== event.owner) {
      throw policyBlocked(`event ${event.name} is owned by ${existing.owner}`);
    }
    this.events.set(event.name, event);
  }

  get(name: string): TypedEvent | undefined {
    return this.events.get(name);
  }

  validate(event: string, payload: unknown, publisher: string): void {
    const registered = this.events.get(event);
    if (!registered) throw invalid(`event ${event} has no registered schema`);
    if (registered.owner !== publisher && registered.owner !== 'kernel') {
      throw policyBlocked(`event ${event} belongs to ${registered.owner}`);
    }
    const parsed = registered.schema.safeParse(payload);
    if (!parsed.success) {
      throw invalid(`event ${event} payload does not match its schema`, parsed.error.issues);
    }
  }
}
