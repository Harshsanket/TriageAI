/** App update check/download/apply (Phase 23.8). Admin-only, audited. */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';
import { AppError } from '@triageai/kernel';

import { applyUpdate, checkForUpdate, downloadUpdate } from '../services/update.js';

export function registerUpdateRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/update', async () => checkForUpdate(kernel));

  app.post('/api/v1/system/update/check', async () => checkForUpdate(kernel, true));

  app.post('/api/v1/system/update/download', async () => downloadUpdate(kernel));

  app.post('/api/v1/system/update/apply', async () => {
    try {
      return await applyUpdate(kernel);
    } catch (err) {
      throw new AppError('update.NOT_STAGED', (err as Error).message, undefined, 409, {
        category: 'conflict',
        retryable: false,
      });
    }
  });
}
