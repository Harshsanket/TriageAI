/** Embedder provider module (Phase 22.T10): serves `embedder` through the
 * egress gate; the model name stays in the inference service config. */
import { z } from 'zod';
import { internal } from '@triageai/kernel';
import type { EmbedResult, TriageModule } from '@triageai/kernel';

const configSchema = z
  .object({
    baseUrl: z.string().url().default('http://localhost:8000'),
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  })
  .strict();

export const embedderProviderModule: TriageModule = {
  id: 'embedder-provider',
  version: '0.0.1',
  capabilities: ['egress'],
  permissions: {
    routes: [],
    events: { publish: [], subscribe: [] },
    capabilities: { consume: ['egress'], provide: ['embedder'] },
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
  lifecycle: { health: async () => ({ status: 'healthy', detail: 'remote embedder provider' }) },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const egress = ctx.capabilities.egress;
    ctx.provideCapability('embedder', {
      async embed(texts: string[]): Promise<EmbedResult> {
        const url = `${options.baseUrl.replace(/\/$/, '')}/ai/v1/embed`;
        const response = egress
          ? await egress.fetch(
              url,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ texts }),
                signal: AbortSignal.timeout(options.timeoutMs),
              },
              { purpose: 'embedder-provider' },
            )
          : await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ texts }),
              signal: AbortSignal.timeout(options.timeoutMs),
            });
        if (!response.ok) throw internal(`embedder provider answered ${response.status}`);
        return (await response.json()) as EmbedResult;
      },
    });
  },
};
