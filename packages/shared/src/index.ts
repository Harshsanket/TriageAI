/**
 * Shared contracts between apps/api and apps/web.
 * Zod schemas defined here are the single source of truth for API shapes;
 * the frontend imports the inferred TS types, the backend re-exports/validates with them.
 */

import { z } from 'zod';

export const UserRole = z.enum(['customer', 'agent', 'admin']);
export type UserRole = z.infer<typeof UserRole>;

export const TicketStatus = z.enum([
  'open',
  'classifying',
  'routing',
  'rag_processing',
  'awaiting_customer',
  'human_review',
  'resolved',
  'closed',
]);
export type TicketStatus = z.infer<typeof TicketStatus>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
