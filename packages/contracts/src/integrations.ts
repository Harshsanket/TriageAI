/**
 * Integration DTOs (Phase 8). Provider-agnostic action/approval surface shared
 * by the GitHub and Slack modules; payloads stay provider-specific.
 */
import { z } from 'zod';

export const IntegrationActionStatusSchema = z.enum([
  'pending_approval',
  'approved',
  'batched',
  'sent',
  'suppressed',
  'rejected',
  'failed',
]);
export type IntegrationActionStatus = z.infer<typeof IntegrationActionStatusSchema>;

export const IntegrationActionDtoSchema = z.object({
  id: z.string(),
  provider: z.enum(['github', 'slack']),
  ticketId: z.string(),
  kind: z.string(),
  channel: z.string().nullable(),
  status: IntegrationActionStatusSchema,
  reason: z.string().nullable(),
  ref: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IntegrationActionDto = z.infer<typeof IntegrationActionDtoSchema>;

export const IntegrationApprovalRequestSchema = z
  .object({
    actor: z.string().min(1).max(200).default('admin'),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type IntegrationApprovalRequest = z.infer<typeof IntegrationApprovalRequestSchema>;
