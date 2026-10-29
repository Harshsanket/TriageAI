import type { FastifyInstance } from 'fastify';

import { HealthResponseSchema } from '@triageai/contracts';

export const API_VERSION = '0.0.1';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => {
    return HealthResponseSchema.parse({ status: 'ok', service: 'api', version: API_VERSION });
  });

  app.get('/readyz', async (_request, reply) => {
    // Kernel migrations applied == core tables + queue exist.
    const kernel = app.kernel;
    if (kernel) {
      const rows = await kernel.database
        .query(`SELECT 1 AS ok FROM kernel_migrations LIMIT 1`)
        .catch(() => []);
      if (rows.length === 0) {
        return reply.status(503).send({ status: 'starting', detail: 'kernel migrations pending' });
      }
    }
    return { status: 'ready' };
  });
}
