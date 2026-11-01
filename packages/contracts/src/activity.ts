/** Activity search DTOs (Phase 18.6). The model may only produce this filter. */
import { z } from 'zod';

export const ActivityKindSchema = z.enum([
  'run',
  'step',
  'ticket',
  'config',
  'approval',
  'tool',
  'handoff',
  'memory',
  'alert',
  'commit',
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivityEventSchema = z.object({
  at: z.string(),
  actor: z.string(),
  kind: ActivityKindSchema,
  subject: z.string(),
  summary: z.string(),
  refs: z.array(z.string()).default([]),
});
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ActivityQuerySchema = z
  .object({
    timeRange: z.object({ from: z.string(), to: z.string() }).strict(),
    actors: z.array(z.string()).optional(),
    kinds: z.array(ActivityKindSchema).optional(),
    modules: z.array(z.string()).optional(),
    agentIds: z.array(z.string()).optional(),
    text: z.string().max(200).optional(),
  })
  .strict();
export type ActivityQuery = z.infer<typeof ActivityQuerySchema>;

export function emptyActivityQuery(from: string, to: string): ActivityQuery {
  return { timeRange: { from, to } };
}
