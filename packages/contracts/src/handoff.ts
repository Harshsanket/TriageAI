/** Handoff DTO (Phase 16): a capped, structured summary between agents. */
import { z } from 'zod';

export const HandoffSchema = z
  .object({
    id: z.string(),
    fromAgentId: z.string(),
    toAgentId: z.string(),
    workItemId: z.string().optional(),
    goal: z.string().min(1),
    status: z.enum(['done', 'partial', 'blocked', 'failed']),
    done: z.array(z.object({ what: z.string(), refs: z.array(z.string()).default([]) })),
    decisions: z.array(
      z.object({
        decisionId: z.string().optional(),
        choice: z.string(),
        reason: z.string(),
        rejected: z.array(z.string()).default([]),
      }),
    ),
    facts: z.array(z.object({ text: z.string(), ref: z.string() })),
    openQuestions: z.array(z.string()).default([]),
    nextSteps: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    artifacts: z.array(z.string()).default([]),
    tokenCount: z.number().int().nonnegative(),
  })
  .strict();
export type Handoff = z.infer<typeof HandoffSchema>;

export const DEFAULT_HANDOFF_CAP_TOKENS = 1500;

/** Trim lowest-value facts first; decisions and next steps are never dropped. */
export function trimHandoff(handoff: Handoff, cap = DEFAULT_HANDOFF_CAP_TOKENS): Handoff {
  if (handoff.tokenCount <= cap) return handoff;
  const facts = [...handoff.facts];
  let tokenCount = handoff.tokenCount;
  while (tokenCount > cap && facts.length > 0) {
    const removed = facts.pop();
    tokenCount -= Math.max(1, Math.ceil((removed?.text.length ?? 0) / 4));
  }
  return { ...handoff, facts, tokenCount: Math.max(0, tokenCount) };
}
