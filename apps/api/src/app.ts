import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';

import { bootKernel, buildKernelConfig, loadConfigFile, PostgresDatabase } from '@triageai/kernel';
import type { Kernel, KernelLogger, RouteRequest } from '@triageai/kernel';
import { chatModule } from '@triageai/module-chat';
import { echoModule } from '@triageai/module-echo';

import { registerHealthRoutes } from './modules/health/routes.js';
import { registerCandidateRoutes } from './system/candidates.js';
import { registerHardwareRoute } from './system/hardware.js';
import { registerMetricsRoute } from './system/metrics.js';
import { registerRunRoutes } from './system/runs.js';
import { AppError } from './platform/errors.js';
import { logger } from './platform/logger.js';
import { config } from './platform/config.js';

export interface BuildAppOptions {
  /** Disable pretty logging in tests. */
  quiet?: boolean;
  /** Test seam: boot routes only, without a kernel/database (Phase 0 behavior). */
  skipBoot?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    kernel?: Kernel;
  }
}

/**
 * App factory kept separate from the entrypoint so tests can build the app
 * and use `app.inject()` without binding a port.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
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

  if (!options.skipBoot) {
    const kernelLogger: KernelLogger = options.quiet
      ? { info: () => undefined, warn: () => undefined, error: () => undefined }
      : (logger as unknown as KernelLogger);
    const database = new PostgresDatabase(config.databaseUrl);
    const kernel = await bootKernel({
      config: buildKernelConfig(loadConfigFile(), process.env),
      database,
      logger: kernelLogger,
      modules: { echo: echoModule, chat: chatModule },
    });
    app.decorate('kernel', kernel);

    registerSystemRoutes(app, kernel);
    registerRunRoutes(app, kernel);
    registerMetricsRoute(app, kernel);
    registerCandidateRoutes(app, kernel);
    registerHardwareRoute(app, kernel);
    for (const route of kernel.routes()) {
      app.route({
        method: route.method,
        url: route.url,
        handler: async (request) =>
          route.handler({
            method: request.method,
            url: request.url.split('?')[0] ?? request.url,
            params: (request.params ?? {}) as Record<string, string>,
            query: Object.fromEntries(
              Object.entries((request.query ?? {}) as Record<string, unknown>).map(([k, v]) => [
                k,
                typeof v === 'string' ? v : String(v ?? ''),
              ]),
            ),
            body: request.body,
          }),
      });
    }

    app.addHook('onClose', async () => {
      await kernel.shutdown();
      await database.close();
    });
  }

  return app;
}

function registerSystemRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/manifest', async () => kernel.manifest());
  app.get('/api/v1/system/modules', async () => kernel.infos());
  app.get('/api/v1/system/modules/health', async () => kernel.health());
  app.post('/api/v1/system/modules/:id/uninstall', async (request) => {
    const { id } = request.params as { id: string };
    return kernel.uninstallModule(id);
  });
}

export type { Kernel, RouteRequest };
