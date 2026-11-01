/** Classifier provider module (Phase 22.T10): serves the `classifier`
 * capability by calling the local inference service through the egress gate. */
import { z } from 'zod';
import { internal } from '@triageai/kernel';
import type { ClassificationResult, TriageModule } from '@triageai/kernel';

const configSchema = z
  .object({
    baseUrl: z.string().url().default('http://localhost:8000'),
    timeoutMs: z.number().int().positive().max(60_000).default(5_000),
  })
  .strict();

export const classifierProviderModule: TriageModule = {
  id: 'classifier-provider',
  version: '0.0.1',
  capabilities: ['egress'],
  permissions: {
    routes: [],
    events: { publish: [], subscribe: [] },
    capabilities: { consume: ['egress'], provide: ['classifier'] },
    stages: [],
    workflows: [],
    evals: [],
    tools: [],
    knowledge: { read: [], write: [] },
  },
  dependsOn: { capabilities: [{ capability: 'egress', optional: true }] },
  configSchema,
  tables: [],
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: { health: async () => ({ status: 'healthy', detail: 'remote classifier provider' }) },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const egress = ctx.capabilities.egress;
    ctx.provideCapability('classifier', {
      async classify(text: string): Promise<ClassificationResult> {
        const url = `${options.baseUrl.replace(/\/$/, '')}/ai/v1/classify`;
        const response = egress
          ? await egress.fetch(
              url,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ text }),
                signal: AbortSignal.timeout(options.timeoutMs),
              },
              { purpose: 'classifier-provider' },
            )
          : await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text }),
              signal: AbortSignal.timeout(options.timeoutMs),
            });
        if (!response.ok) throw internal(`classifier provider answered ${response.status}`);
        return (await response.json()) as ClassificationResult;
      },
    });
  },
};
