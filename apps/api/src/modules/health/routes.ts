import type { FastifyInstance } from 'fastify';

import { HealthResponse } from '@triageai/shared';

export const API_VERSION = '0.0.1';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => {
    return HealthResponse.parse({ status: 'ok', service: 'api', version: API_VERSION });
  });

  app.get('/readyz', async () => {
    // Phase 1 will add DB/Redis readiness probes here.
    return { status: 'ready' };
  });
}
