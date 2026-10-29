import { z } from 'zod';

/** `GET /healthz` body for every host (api, ai-service mirrors it). */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
