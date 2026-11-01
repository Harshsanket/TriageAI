/**
 * Generic job progress read model (Phase 20.1). Job ids equal workflow run ids
 * for workflow-backed jobs; the shape is use-case-free on purpose (ADR-0001).
 */
import { z } from 'zod';

export const JobStatusSchema = z.enum([
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'awaiting',
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobDtoSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  workflowId: z.string().nullable(),
  title: z.string(),
  stage: z.string().nullable(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  unit: z.string(),
  status: JobStatusSchema,
  error: z.string().nullable(),
  ownerId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JobDto = z.infer<typeof JobDtoSchema>;

export const JobsResponseSchema = z.object({
  active: z.array(JobDtoSchema),
  recent: z.array(JobDtoSchema),
});
export type JobsResponse = z.infer<typeof JobsResponseSchema>;
