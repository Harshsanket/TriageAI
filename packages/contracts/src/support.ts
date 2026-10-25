/**
 * Support module public DTOs (Phases 5/7): auto-reply policy, customer
 * confirmation, and advanced triage (P0–P3 priority + team overrides). Kept in
 * contracts so the wire shape is shared and JSON-Schema export stays available.
 */
import { z } from 'zod';

export const AutoReplyFallbackPolicySchema = z.enum([
  'request_clarification',
  'return_uncertain',
  'escalate_human',
  'halt_run',
  'retry_alternative_retrieval',
]);

export const AutoReplyPolicyDtoSchema = z.object({
  category: z.string(),
  version: z.number().int().positive(),
  enabled: z.boolean(),
  fallbackPolicy: AutoReplyFallbackPolicySchema,
  collection: z.string(),
  maxAnswerChars: z.number().int().positive(),
  note: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type AutoReplyPolicyDto = z.infer<typeof AutoReplyPolicyDtoSchema>;

export const AutoReplyPolicyUpdateSchema = z
  .object({
    enabled: z.boolean(),
    fallbackPolicy: AutoReplyFallbackPolicySchema.optional(),
    collection: z.string().min(1).max(200).optional(),
    maxAnswerChars: z.number().int().positive().max(20_000).optional(),
    note: z.string().max(500).optional(),
    updatedBy: z.string().min(1).max(200).default('admin'),
  })
  .strict();

/** Phase 7 priority codes (impact/severity/availability policy). */
export const TicketPriorityCodeSchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type TicketPriorityCode = z.infer<typeof TicketPriorityCodeSchema>;

export const TicketTriagePolicyDtoSchema = z.object({
  priorities: z.array(TicketPriorityCodeSchema),
  teamIds: z.array(z.string()),
  ambiguous: z.string(),
});
export type TicketTriagePolicyDto = z.infer<typeof TicketTriagePolicyDtoSchema>;

export const TicketTriageOverrideRequestSchema = z
  .object({
    priorityCode: TicketPriorityCodeSchema,
    teamId: z.string().min(1).max(100),
    actor: z.string().min(1).max(200).default('agent'),
    method: z.enum(['mistake', 'better_answer']).default('mistake'),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type TicketTriageOverrideRequest = z.infer<typeof TicketTriageOverrideRequestSchema>;

export const TicketConfirmationRequestSchema = z
  .object({
    solved: z.boolean(),
    note: z.string().max(5000).optional(),
  })
  .strict();

export const TicketConfirmationResponseSchema = z.object({
  ticketId: z.string(),
  status: z.enum(['RESOLVED', 'HUMAN_REVIEW']),
  autoReplyId: z.string().nullable(),
});
export type TicketConfirmationResponse = z.infer<typeof TicketConfirmationResponseSchema>;
