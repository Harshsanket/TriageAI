/**
 * Error envelope contract (Phase 10C): one shape at every boundary.
 * `userMessage` is safe to show anyone; `detail` is operator-only and must be
 * stripped for non-admins by the boundary that renders it.
 */
import { z } from 'zod';

export const ErrorCategorySchema = z.enum([
  'validation',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'dependency_unavailable',
  'timeout',
  'budget_exceeded',
  'policy_blocked',
  'internal',
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const ErrorEnvelopeSchema = z.object({
  /** RFC-7807-style type URI: https://triageai.dev/errors/<code>. */
  type: z.string().url(),
  /** Human-readable title; equals `code` in v1. */
  title: z.string().min(1),
  /** HTTP status. */
  status: z.number().int().min(400).max(599),
  /** Stable code, `<owner>.<REASON>` (legacy short codes are migrated by 10C.T2/T3). */
  code: z.string().min(1),
  category: ErrorCategorySchema,
  /** Whether the same operation may succeed when retried. */
  retryable: z.boolean(),
  /** Server-suggested delay before a retry. */
  retryAfterMs: z.number().int().nonnegative().optional(),
  /** Safe for anyone (users, logs, UI). */
  userMessage: z.string().min(1),
  /** Operator-only message; stripped for non-admins. */
  detail: z.string().optional(),
  /** Request, run or trace id that joins this failure to its logs. */
  correlationId: z.string().min(1),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Structured failure kept on a decision record or dead-letter row (10C.T5). */
export const StructuredErrorSchema = z.object({
  code: z.string().min(1),
  category: ErrorCategorySchema,
  retryable: z.boolean(),
  message: z.string(),
  attempt: z.number().int().nonnegative(),
  causeCode: z.string().optional(),
});
export type StructuredError = z.infer<typeof StructuredErrorSchema>;
