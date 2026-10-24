import { describe, expect, it } from 'vitest';

import {
  assertTransition,
  canTransition,
  IllegalTicketTransitionError,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  type TicketStatus,
} from '../src/state.js';

describe('ticket state machine', () => {
  it('matches the expected transition matrix exactly', () => {
    const expected: Record<TicketStatus, TicketStatus[]> = {
      NEW: ['CLASSIFIED', 'ROUTED', 'HUMAN_REVIEW', 'CANCELLED'],
      CLASSIFIED: ['ROUTED', 'AWAITING_CUSTOMER', 'HUMAN_REVIEW', 'CANCELLED'],
      ROUTED: ['AWAITING_CUSTOMER', 'HUMAN_REVIEW', 'RESOLVED', 'CANCELLED'],
      AWAITING_CUSTOMER: ['RESOLVED', 'HUMAN_REVIEW', 'CANCELLED'],
      HUMAN_REVIEW: ['RESOLVED', 'CANCELLED'],
      RESOLVED: [],
      CANCELLED: [],
    };
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        expect([from, to, canTransition(from, to)]).toEqual([
          from,
          to,
          expected[from].includes(to),
        ]);
      }
    }
  });

  it('has no cycles and no outgoing edges from terminal states', () => {
    const visiting = new Set<TicketStatus>();
    const visited = new Set<TicketStatus>();
    const visit = (node: TicketStatus): void => {
      if (visiting.has(node)) throw new Error(`cycle at ${node}`);
      if (visited.has(node)) return;
      visiting.add(node);
      for (const next of TICKET_TRANSITIONS[node]) visit(next);
      visiting.delete(node);
      visited.add(node);
    };
    for (const status of TICKET_STATUSES) visit(status);

    expect(TICKET_TRANSITIONS.RESOLVED).toEqual([]);
    expect(TICKET_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('every declared target is itself a known status', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_TRANSITIONS[from]) expect(TICKET_STATUSES).toContain(to);
    }
  });

  it('throws a typed conflict on illegal transitions', () => {
    expect(() => assertTransition('RESOLVED', 'ROUTED')).toThrow(IllegalTicketTransitionError);
    try {
      assertTransition('NEW', 'RESOLVED');
    } catch (err) {
      expect((err as IllegalTicketTransitionError).code).toBe('CONFLICT');
      expect((err as IllegalTicketTransitionError).from).toBe('NEW');
      expect((err as IllegalTicketTransitionError).to).toBe('RESOLVED');
    }
    expect(() => assertTransition('NEW', 'ROUTED')).not.toThrow();
  });
});
