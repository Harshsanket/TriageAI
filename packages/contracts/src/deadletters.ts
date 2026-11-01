/**
 * Dead-letter read model + replay/discard responses (10C.T5). The queue keeps
 * one row per job that exhausted its attempts; admins can replay or discard it.
 */
import { z } from 'zod';

import { StructuredErrorSchema } from './errors.js';

export const DeadLetterDtoSchema = z.object({
  id: z.string(),
  queue: z.string(),
  payload: z.unknown(),
  attempts: z.number().int().nonnegative(),
  error: z.string(),
  errorDetails: StructuredErrorSchema.nullable(),
  createdAt: z.string(),
});
export type DeadLetterDto = z.infer<typeof DeadLetterDtoSchema>;

export const DeadLetterReplayResponseSchema = z.object({
  id: z.string(),
  replayed: z.literal(true),
  jobId: z.string(),
});
export type DeadLetterReplayResponse = z.infer<typeof DeadLetterReplayResponseSchema>;

export const DeadLetterDiscardResponseSchema = z.object({
  id: z.string(),
  discarded: z.literal(true),
});
export type DeadLetterDiscardResponse = z.infer<typeof DeadLetterDiscardResponseSchema>;
