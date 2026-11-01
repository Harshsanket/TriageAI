/** Scenario cases (Phase 18.1/18.T27): the regression gate. */
import { z } from 'zod';

export const ScenarioCategorySchema = z.enum([
  'happy',
  'ambiguous',
  'out_of_scope',
  'tool_failure',
  'malicious',
  'invalid_input',
  'partial_info',
  'policy_edge',
]);
export type ScenarioCategory = z.infer<typeof ScenarioCategorySchema>;

export const ScenarioCaseSchema = z
  .object({
    id: z.string(),
    target: z.string(),
    category: ScenarioCategorySchema,
    input: z.unknown(),
    fixtures: z.record(z.string(), z.unknown()).optional(),
    expect: z
      .object({
        edges: z.array(z.string()).optional(),
        toolsCalled: z.array(z.string()).optional(),
        toolsNotCalled: z.array(z.string()).optional(),
        outputSchema: z.string().optional(),
        refusal: z.boolean().optional(),
        clarifyingQuestion: z.boolean().optional(),
        stateChanges: z.record(z.string(), z.unknown()).optional(),
      })
      .default({}),
    grading: z.array(z.enum(['deterministic', 'judge'])).default(['deterministic']),
    source: z.enum(['authored', 'incident', 'user_flag', 'step_eval']).default('authored'),
  })
  .strict();
export type ScenarioCase = z.infer<typeof ScenarioCaseSchema>;

export const CATEGORY_PASS_FLOOR: Record<ScenarioCategory, number> = {
  happy: 0.9,
  ambiguous: 0.9,
  out_of_scope: 0.9,
  tool_failure: 0.9,
  malicious: 1,
  invalid_input: 1,
  partial_info: 0.9,
  policy_edge: 1,
};
