/**
 * Chat module (Phase 1 stub): wireframe only — routes/nav/UI gate through the
 * manifest registry without real LLM wiring. Real chat lands in Phase 3,
 * driven by the Generator capability (docs/DEVELOPMENT_PLAN.md §phases).
 */
import { z } from 'zod';

import type { TriageModule } from '@triageai/kernel';

const configSchema = z
  .object({
    greeting: z.string().default('Hello from the chat module (stub)'),
  })
  .strict();

export const chatModule: TriageModule = {
  id: 'chat',
  version: '0.1.0',
  capabilities: ['generator'],
  dependsOn: { modules: [], capabilities: [] },
  configSchema,
  manifest: {
    routes: [{ path: '/chat', title: 'Chat' }],
    nav: [{ label: 'Chat', order: 20, path: '/chat' }],
    background: [],
  },
  lifecycle: {
    health: async () => ({
      status: 'degraded',
      detail: 'stub module; generator capability not wired yet',
    }),
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/chat/echo',
      handler: async (request) => {
        const body = z.object({ text: z.string().min(1) }).parse(request.body);
        return { ok: true, greeting: options.greeting, echo: body.text };
      },
    });
  },
};
