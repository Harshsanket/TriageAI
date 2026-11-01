import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EventSchemaRegistry } from '../src/typedEvents.js';

describe('typed event registry (ADR-0055 §4)', () => {
  it('validates payloads and ownership', () => {
    const registry = new EventSchemaRegistry();
    expect(() =>
      registry.validate('support.ticket.created', { ticketId: 't1' }, 'support'),
    ).not.toThrow();
    expect(() => registry.validate('support.ticket.created', {}, 'support')).toThrow(
      /does not match its schema/,
    );
    expect(() => registry.validate('support.ticket.created', { ticketId: 't1' }, 'chat')).toThrow(
      /belongs to support/,
    );
    expect(() => registry.validate('unknown.event', {}, 'unknown')).toThrow(/no registered schema/);
  });

  it('lets the owner register a module event schema', () => {
    const registry = new EventSchemaRegistry([]);
    registry.register({
      name: 'demo.changed',
      owner: 'demo',
      schema: z.object({ id: z.string() }).strict(),
    });
    expect(() => registry.validate('demo.changed', { id: 'x' }, 'demo')).not.toThrow();
    expect(() => registry.validate('demo.changed', { id: 1 }, 'demo')).toThrow();
  });
});
