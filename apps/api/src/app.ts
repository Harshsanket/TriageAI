import Fastify from 'fastify';
import type { FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';

import { registerHealthRoutes } from './modules/health/routes.js';
import { AppError } from './platform/errors.js';
import { logger } from './platform/logger.js';

export interface BuildAppOptions {
  /** Disable pretty logging in tests. */
  quiet?: boolean;
}

/**
 * App factory kept separate from the entrypoint so tests can build the app
 * and use `app.inject()` without binding a port.
 */
export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify(
    options.quiet
      ? { logger: false, genReqId: () => crypto.randomUUID() }
      : { loggerInstance: logger as FastifyBaseLogger, genReqId: () => crypto.randomUUID() },
  );

  await app.register(cors, { origin: true });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        type: `https://triageai.dev/errors/${error.code}`,
        title: error.code,
        status: error.statusCode,
        detail: error.message,
        ...(error.details !== undefined ? { instance: request.url, details: error.details } : {}),
      });
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send({
        type: 'https://triageai.dev/errors/VALIDATION_ERROR',
        title: 'VALIDATION_ERROR',
        status: 400,
        detail: 'Request validation failed',
        issues: error.issues,
      });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({
      type: 'https://triageai.dev/errors/INTERNAL_ERROR',
      title: 'INTERNAL_ERROR',
      status: 500,
      detail: 'Internal server error',
    });
  });

  await registerHealthRoutes(app);

  return app;
}
