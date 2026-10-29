import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';

import { bootKernel, buildKernelConfig, loadConfigFile, PostgresDatabase } from '@triageai/kernel';
import type { Kernel, KernelLogger, RouteRequest, TriageModule } from '@triageai/kernel';
import { aiPipelineModule } from '@triageai/module-ai-pipeline';
import { chatModule } from '@triageai/module-chat';
import { docAssistantModule } from '@triageai/module-doc-assistant';
import { echoModule } from '@triageai/module-echo';
import { integrationsGitHubModule } from '@triageai/module-integrations-github';
import { integrationsSlackModule } from '@triageai/module-integrations-slack';
import { kbModule } from '@triageai/module-kb';
import { supportModule } from '@triageai/module-support';

import { registerHealthRoutes } from './routes/health.js';
import { registerHostRoutes } from './routes/index.js';
import { createCapabilities } from './services/capabilities.js';
import { DbModelRegistry } from './services/modelRegistry.js';
import { AppError } from './platform/errors.js';
import { logger } from './platform/logger.js';
import { config } from './platform/config.js';
import { createAuthGuard, registerAuthRoutes } from './platform/auth/index.js';
import { AuthService } from './platform/auth/service.js';

/** Every first-party module the host can boot; config decides which are enabled. */
export const MODULES: Record<string, TriageModule> = {
  echo: echoModule,
  chat: chatModule,
  support: supportModule,
  'ai-pipeline': aiPipelineModule,
  kb: kbModule,
  'doc-assistant': docAssistantModule,
  'integrations-github': integrationsGitHubModule,
  'integrations-slack': integrationsSlackModule,
};

export interface BuildAppOptions {
  /** Disable pretty logging in tests. */
  quiet?: boolean;
  /** Test seam: boot routes only, without a kernel/database (Phase 0 behavior). */
  skipBoot?: boolean;
  /** Test seam: explicit config file path instead of the cwd probe. */
  configPath?: string;
  /** Test seam: inject capability adapters instead of calling ai-service. */
  capabilities?: import('@triageai/kernel').Capabilities;
  /** Test seam: override the boot-time auth mode. */
  authMode?: 'disabled' | 'required';
  /** Test seam: override rate limiting (max 0 disables it). */
  rateLimit?: { max?: number; timeWindow?: string };
}

declare module 'fastify' {
  interface FastifyInstance {
    kernel?: Kernel;
  }
  interface FastifyRequest {
    rawBody?: string;
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

  // Reflecting every origin would let any page the operator visits drive the
  // admin API (uninstall drops tables) whenever AUTH_MODE=disabled.
  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
  });

  // Capture the raw JSON for webhook HMAC verification before parsing.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, raw, done) => {
    const rawBody = typeof raw === 'string' ? raw : raw.toString('utf8');
    request.rawBody = rawBody;
    try {
      done(null, rawBody.length > 0 ? JSON.parse(rawBody) : null);
    } catch (err) {
      // A malformed body is the client's fault, not a server fault.
      done(Object.assign(err as Error, { statusCode: 400, code: 'INVALID_JSON' }), undefined);
    }
  });

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
    // Framework/plugin client errors (rate limit 429, bad JSON 400, body too
    // large 413) carry their own status; only genuine faults become 500s.
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send({
        type: `https://triageai.dev/errors/HTTP_${statusCode}`,
        title: (error as { code?: string }).code ?? `HTTP_${statusCode}`,
        status: statusCode,
        detail: (error as Error).message,
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
    const kernelConfig = buildKernelConfig(loadConfigFile(options.configPath), process.env);
    const authMode = options.authMode ?? config.authMode;
    const authService = new AuthService(database, {
      accessTtlSeconds: config.authAccessTtlSeconds,
      refreshTtlSeconds: config.authRefreshTtlSeconds,
      jwtSecret: config.authJwtSecret,
    });

    const limitMax = options.rateLimit?.max ?? config.rateLimitMax;
    if (limitMax > 0) {
      await app.register(rateLimit, {
        global: true,
        max: limitMax,
        timeWindow: options.rateLimit?.timeWindow ?? config.rateLimitWindow,
      });
    }
    registerAuthRoutes(app, authService, { mode: authMode });
    app.addHook(
      'preHandler',
      createAuthGuard({
        mode: authMode,
        jwtSecret: config.authJwtSecret,
        metricsToken: config.metricsToken,
      }),
    );
    const modelRegistry = new DbModelRegistry(database);
    // Never mutate a caller-provided capability bag: tests reuse one object
    // across app instances, and a leaked registry would point at a closed DB.
    const capabilities = {
      ...(options.capabilities ??
        createCapabilities(kernelConfig, config.aiServiceUrl, database, modelRegistry)),
    };
    capabilities.modelRegistry ??= modelRegistry;
    const activeRegistry =
      capabilities.modelRegistry instanceof DbModelRegistry
        ? capabilities.modelRegistry
        : modelRegistry;
    const kernel = await bootKernel({
      config: kernelConfig,
      database,
      logger: kernelLogger,
      capabilities,
      modules: MODULES,
    });
    app.decorate('kernel', kernel);

    let retentionTimer: NodeJS.Timeout | undefined;
    if (kernel.config.retention?.enabled) {
      retentionTimer = setInterval(
        () => {
          void kernel
            .runRetention()
            .catch((err: unknown) =>
              kernelLogger.error({ err: (err as Error).message }, 'retention pass failed'),
            );
        },
        kernel.config.retention.intervalHours * 60 * 60 * 1000,
      );
      retentionTimer.unref();
    }

    registerHostRoutes(app, kernel, { modelRegistry: activeRegistry });

    app.addHook('onClose', async () => {
      if (retentionTimer) clearInterval(retentionTimer);
      await kernel.shutdown();
      await database.close();
    });
  }

  return app;
}

export type { Kernel, RouteRequest };
