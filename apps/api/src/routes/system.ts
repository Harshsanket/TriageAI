/** Kernel introspection + admin surface: manifest, modules, config, uninstall. */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

import { config } from '../platform/config.js';
import { redactValue } from '../platform/redact.js';

export function registerSystemRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/manifest', async () => kernel.manifest());
  app.get('/api/v1/system/modules', async () => kernel.infos());
  app.get('/api/v1/system/modules/health', async () => kernel.health());
  app.get('/api/v1/system/config', async () =>
    redactValue({
      profile: kernel.config.profile,
      queue: kernel.config.queue,
      modules: kernel.config.modules,
      capabilities: kernel.config.capabilities,
      authMode: config.authMode,
      rateLimit: { max: config.rateLimitMax, window: config.rateLimitWindow },
    }),
  );
  app.post('/api/v1/system/modules/:id/uninstall', async (request) => {
    const { id } = request.params as { id: string };
    return kernel.uninstallModule(id);
  });
}
