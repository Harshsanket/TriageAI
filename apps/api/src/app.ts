import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';

import {
  applyConfigOverlay,
  bootKernel,
  buildKernelConfig,
  loadConfigFile,
  PostgresDatabase,
} from '@triageai/kernel';
import type {
  Capabilities,
  Kernel,
  KernelLogger,
  RouteRequest,
  TriageModule,
} from '@triageai/kernel';
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
import {
  finishSetupBoot,
  prepareSetup,
  processPendingImports,
  recoverFailedApply,
  type SetupRuntime,
} from './setup/boot.js';
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
  capabilities?: Capabilities;
  /** Test seam: override the boot-time auth mode. */
  authMode?: 'disabled' | 'required';
  /** Test seam: a different database (e.g. a fresh one for first-run setup). */
  databaseUrl?: string;
  /** Test seam: force the first-run setup gate on/off (default: TRIAGEAI_SETUP). */
  setup?: boolean;
  /** Exit after a wizard apply so a supervisor restarts with the new config. */
  restartOnApply?: boolean;
  /** Test seam: override rate limiting (max 0 disables it). */
  rateLimit?: { max?: number; timeWindow?: string };
}

declare module 'fastify' {
  interface FastifyInstance {
    kernel?: Kernel;
    setupRuntime?: SetupRuntime;
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
    const database = new PostgresDatabase(options.databaseUrl ?? config.databaseUrl);
    // Setup state, saved overlay, stored secrets and auth mode are resolved
    // before the kernel boots: they decide what it boots (ADR-0024).
    const setup = await prepareSetup({
      database,
      enabled: options.setup ?? config.setupEnabled,
      secretKey: config.secretKey,
      authModeOverride: options.authMode,
      authModeEnv: config.authModeEnv,
      jwtSecretEnv: config.authJwtSecretEnv,
      devJwtSecret: config.authJwtSecret,
      nodeEnv: config.nodeEnv,
      logger: kernelLogger,
    });
    const { runtime } = setup;
    const fileConfig = loadConfigFile(options.configPath);
    const authMode = runtime.authMode;
    if (authMode === 'disabled' && config.nodeEnv === 'production') {
      kernelLogger.warn(
        'auth is disabled in production mode: every request is an admin. Only run this way on a loopback-bound port (see SETUP.md).',
      );
    }
    const authService = new AuthService(database, {
      accessTtlSeconds: config.authAccessTtlSeconds,
      refreshTtlSeconds: config.authRefreshTtlSeconds,
      jwtSecret: setup.jwtSecret,
    });

    // Until setup is complete only health and /api/v1/setup/* answer.
    app.addHook('onRequest', async (request) => {
      if (runtime.state === 'complete' || !runtime.enabled) return;
      const path = request.url.split('?')[0] ?? request.url;
      if (
        request.method === 'OPTIONS' ||
        path === '/healthz' ||
        path === '/readyz' ||
        path.startsWith('/api/v1/setup/')
      ) {
        return;
      }
      throw new AppError(
        'setup.REQUIRED',
        runtime.state === 'applied'
          ? 'setup was applied; restart the API to boot the new configuration'
          : 'finish first-run setup at /config',
        { state: runtime.state },
        409,
      );
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
        jwtSecret: setup.jwtSecret,
        metricsToken: config.metricsToken,
        setup: {
          isPending: () => runtime.enabled && runtime.state === 'pending',
          verify: (header) => runtime.token.verify(header),
        },
      }),
    );
    const modelRegistry = new DbModelRegistry(database);

    let kernel: Kernel;
    let kernelConfig: ReturnType<typeof buildKernelConfig>;
    let capabilities: Capabilities;
    try {
      const effectiveFile = setup.overlay
        ? applyConfigOverlay(fileConfig, setup.overlay.overlay)
        : fileConfig;
      kernelConfig = buildKernelConfig(effectiveFile, setup.env as NodeJS.ProcessEnv);
      // Never mutate a caller-provided capability bag: tests reuse one object
      // across app instances, and a leaked registry would point at a closed DB.
      capabilities = {
        ...(options.capabilities ??
          createCapabilities(kernelConfig, config.aiServiceUrl, database, modelRegistry)),
      };
      capabilities.modelRegistry ??= modelRegistry;
      kernel = await bootKernel({
        config: kernelConfig,
        database,
        logger: kernelLogger,
        capabilities,
        modules: MODULES,
        env: setup.env,
      });
    } catch (err) {
      if (runtime.state === 'applied') await recoverFailedApply(runtime, err, kernelLogger);
      await database.close();
      throw err;
    }
    const activeRegistry =
      capabilities.modelRegistry instanceof DbModelRegistry
        ? capabilities.modelRegistry
        : modelRegistry;
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

    await finishSetupBoot(runtime, setup.fresh, kernelLogger, (line) =>
      // The token must reach the operator even when logs are JSON or quiet.
      options.quiet ? undefined : process.stdout.write(`${line}\n`),
    );
    app.decorate('setupRuntime', runtime);

    registerHostRoutes(app, kernel, {
      modelRegistry: activeRegistry,
      setup: {
        runtime,
        file: fileConfig,
        modules: MODULES,
        env: setup.env,
        authService,
        restartOnApply: options.restartOnApply ?? config.restartOnApply,
      },
    });

    // Knowledge queued by the wizard is imported once the KB module runs.
    app.addHook('onReady', async () => {
      void processPendingImports(runtime, kernel, kernelLogger).catch((err: unknown) =>
        kernelLogger.error({ err: (err as Error).message }, 'setup imports failed'),
      );
    });

    app.addHook('onClose', async () => {
      if (retentionTimer) clearInterval(retentionTimer);
      await kernel.shutdown();
      await database.close();
    });
  }

  return app;
}

export type { Kernel, RouteRequest };
