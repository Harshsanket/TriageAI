/** Ticket state machine (Phase 3) — illegal transitions are typed errors. */
import { AppError } from '@triageai/kernel';
export const TICKET_STATUSES = [
  'NEW',
  'CLASSIFIED',
  'ROUTED',
  'HUMAN_REVIEW',
  'RESOLVED',
  'CANCELLED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  NEW: ['CLASSIFIED', 'ROUTED', 'HUMAN_REVIEW', 'CANCELLED'],
  CLASSIFIED: ['ROUTED', 'HUMAN_REVIEW', 'CANCELLED'],
  ROUTED: ['HUMAN_REVIEW', 'RESOLVED', 'CANCELLED'],
  HUMAN_REVIEW: ['RESOLVED', 'CANCELLED'],
  RESOLVED: [],
  CANCELLED: [],
};

export class IllegalTicketTransitionError extends AppError {
  constructor(
    readonly from: TicketStatus,
    readonly to: TicketStatus,
  ) {
    super('CONFLICT', `illegal ticket transition ${from} → ${to}`, { from, to });
    this.name = 'IllegalTicketTransitionError';
  }
}

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: string, to: string): asserts to is TicketStatus {
  if (!TICKET_STATUSES.includes(from as TicketStatus)) {
    throw new IllegalTicketTransitionError(from as TicketStatus, to as TicketStatus);
  }
  if (
    !TICKET_STATUSES.includes(to as TicketStatus) ||
    !canTransition(from as TicketStatus, to as TicketStatus)
  ) {
    throw new IllegalTicketTransitionError(from as TicketStatus, to as TicketStatus);
  }
}
