/**
 * AI service wire contracts (Node ↔ Python). These are the exact HTTP shapes
 * served by apps/ai-service under /ai/v1; the Pydantic models must match
 * (contract test in apps/api/test/ai.contract.test.ts).
 */
import { z } from 'zod';

export const AiEmbedRequestSchema = z.object({
  texts: z.array(z.string().min(1)).min(1).max(64),
});
export type AiEmbedRequest = z.infer<typeof AiEmbedRequestSchema>;

export const AiEmbedResponseSchema = z.object({
  vectors: z.array(z.array(z.number())).min(1),
  modelVersion: z.string(),
});
export type AiEmbedResponse = z.infer<typeof AiEmbedResponseSchema>;

/**
 * Optional model descriptor (Phase 7). The host resolves the active registry
 * pointer and forwards it; the ai-service loads that artifact instead of the
 * default similarity backend. `artifactRef` is resolved under the service's
 * artifacts directory, never as an arbitrary path.
 */
export const AiClassifyModelSchema = z.object({
  name: z.string().min(1),
  artifactRef: z.string().min(1),
  kind: z.enum(['similarity', 'linear-probe']),
});
export type AiClassifyModel = z.infer<typeof AiClassifyModelSchema>;

export const AiClassifyRequestSchema = z.object({
  text: z.string().min(1).max(20_000),
  model: AiClassifyModelSchema.optional(),
});
export type AiClassifyRequest = z.infer<typeof AiClassifyRequestSchema>;

export const AiCategoryScoreSchema = z.object({
  category: z.string(),
  score: z.number().min(0).max(1),
});
export type AiCategoryScore = z.infer<typeof AiCategoryScoreSchema>;

export const AiClassifyResponseSchema = z.object({
  category: z.string(),
  confidence: z.number().min(0).max(1),
  margin: z.number().min(0).max(1),
  method: z.enum(['zero-shot', 'trained']),
  modelVersion: z.string(),
  scores: z.array(AiCategoryScoreSchema),
});
export type AiClassifyResponse = z.infer<typeof AiClassifyResponseSchema>;
