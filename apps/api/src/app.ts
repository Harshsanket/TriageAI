import { resolve } from 'node:path';

import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';

import {
  applyConfigOverlay,
  bootKernel,
  buildKernelConfig,
  invalid,
  loadConfigFile,
  loadInstalledPlugins,
  ApprovalStore,
  FilesystemBlobStore,
  MemoryCache,
  PostgresDatabase,
} from '@triageai/kernel';
import type {
  Capabilities,
  Kernel,
  KernelLogger,
  RouteRequest,
  TriageModule,
  TrustedPluginKey,
} from '@triageai/kernel';

import { MODULES } from './modules.js';
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
import { BaseMemoryService } from './services/baseMemory.js';
import { syncSkillMirror } from './services/skills.js';
import { readSystemStatus, type ConnectedApiFact } from './services/dashboardReads.js';
import { registerSystemTools } from './services/systemTools.js';
import { readConnections } from './routes/connections.js';
import { EgressClient } from './services/egress.js';
import { checkForUpdate } from './services/update.js';
import {
  recordBoot,
  runUptimeMaintenance,
  startUptimeProbes,
  uptimeTargets,
} from './services/uptime.js';
import { DbModelRegistry } from './services/modelRegistry.js';
import { getControls } from './services/controls.js';
import { PluginStore } from './services/plugins.js';
import { KERNEL_API_VERSION, parsePluginKeys } from './routes/plugins.js';
import { AppError } from './platform/errors.js';
import { scrubSecrets } from './platform/redact.js';
import { logger } from './platform/logger.js';
import { config } from './platform/config.js';
import { createAuthGuard, registerAuthRoutes } from './platform/auth/index.js';
import { AuthService } from './platform/auth/service.js';

export { MODULES } from './modules.js';

/** Keep in sync with docker/nginx.conf and the pre-paint hash in index.html. */
export const SECURITY_CSP =
  "default-src 'self'; script-src 'self' 'sha256-EJFONL2tszoS4TNTHWzjuczFEhpYeFEvFheWsSyeqqA='; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";

export interface BuildAppOptions {
  /** Disable pretty logging in tests. */
  quiet?: boolean;
  /** Test seam: boot routes only, without a kernel/database (Phase 0 behavior). */
  skipBoot?: boolean;
  /** Test seam: explicit config file path instead of the cwd probe. */
  configPath?: string;
  /** Test seam: inject capability adapters instead of calling ai-service. */
  capabilities?: Capabilities;
  /** Test seam: override Fastify's trustProxy setting. */
  trustProxy?: boolean | string | string[];
  /** Test seam: override the boot-time auth mode. */
  authMode?: 'disabled' | 'required';
  /** Test seam: a different database (e.g. a fresh one for first-run setup). */
  databaseUrl?: string;
  /** Test seam: force the first-run setup gate on/off (default: TRIAGEAI_SETUP). */
  setup?: boolean;
  /** Exit after a wizard apply so a supervisor restarts with the new config. */
  restartOnApply?: boolean;
  /** Test seam: replace the process exit used by `/setup/restart`. */
  restart?: () => void;
  /** Test seam: override rate limiting (max 0 disables it). */
  rateLimit?: { max?: number; timeWindow?: string };
  /** Phase 12: plugin volume and pinned ed25519 keys (tests use temp dirs). */
  pluginsRoot?: string;
  pluginKeys?: TrustedPluginKey[];
  pluginRegistryUrl?: string;
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
  const app = Fastify({
    ...(options.quiet
      ? { logger: false as const }
      : { loggerInstance: logger as FastifyBaseLogger }),
    genReqId: () => crypto.randomUUID(),
    trustProxy: options.trustProxy ?? config.trustProxy,
  });

  // Reflecting every origin would let any page the operator visits drive the
  // admin API (uninstall drops tables) whenever AUTH_MODE=disabled.
  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
  });

  // Baseline security headers on every API response (R10). R24: the API is
  // also a static origin for plugin bundles, so it must send the same CSP as
  // nginx instead of relying on the proxy for every deployment.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', SECURITY_CSP);
    return payload;
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

  /**
   * One envelope at the API boundary (10C.T2). `detail` is operator-only;
   * `details` is an extension for structured fields such as zod issues.
   */
  const sendEnvelope = (request: FastifyRequest, reply: FastifyReply, error: AppError): void => {
    const envelope: ReturnType<AppError['toEnvelope']> & { details?: unknown } = error.toEnvelope(
      request.id,
    );
    envelope.userMessage = scrubSecrets(envelope.userMessage);
    if (envelope.detail) envelope.detail = scrubSecrets(envelope.detail);
    if (!(request.principal?.authenticated && request.principal.role === 'admin'))
      delete envelope.detail;
    reply.status(error.statusCode).send({
      ...envelope,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      sendEnvelope(request, reply, error);
      return;
    }
    if (error instanceof ZodError) {
      sendEnvelope(request, reply, invalid('Request validation failed', error.issues));
      return;
    }
    // Framework/plugin client errors (rate limit 429, bad JSON 400, body too
    // large 413) carry their own status; only genuine faults become 500s.
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const code =
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : `HTTP_${statusCode}`;
      const retryAfter = Number(reply.getHeader('retry-after'));
      const retryAfterMs =
        statusCode === 429 && Number.isFinite(retryAfter)
          ? Math.max(0, retryAfter * 1000)
          : undefined;
      sendEnvelope(
        request,
        reply,
        new AppError(code, (error as Error).message, undefined, statusCode, { retryAfterMs }),
      );
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    sendEnvelope(
      request,
      reply,
      new AppError('INTERNAL_ERROR', (error as Error).message, undefined, 500, {
        category: 'internal',
        retryable: false,
      }),
    );
  });

  app.setNotFoundHandler((request, reply) => {
    sendEnvelope(
      request,
      reply,
      new AppError(
        'NOT_FOUND',
        `Route ${request.method} ${request.url} not found`,
        undefined,
        404,
        {
          category: 'not_found',
          retryable: false,
          userMessage: 'The requested resource was not found.',
        },
      ),
    );
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
    const baseMemory = new BaseMemoryService(kernelLogger, runtime);
    let liveKernel: Kernel | undefined;
    const connectedFacts = async (): Promise<ConnectedApiFact[]> => {
      if (!liveKernel) return [];
      const result = await readConnections(liveKernel, runtime).catch(() => ({ connections: [] }));
      return result.connections.map((connection) => ({
        name: connection.name,
        type: connection.type,
        status: connection.status,
        ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
      }));
    };
    const systemReads = {
      status: async (connectedApis: ConnectedApiFact[]): Promise<Record<string, unknown>> => {
        if (!liveKernel) return { asOf: new Date().toISOString(), database: 'down' };
        return readSystemStatus(liveKernel, { connectedApis }) as unknown as Record<
          string,
          unknown
        >;
      },
      connections: connectedFacts,
    };
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
    const pluginStore = new PluginStore(database);
    const pluginsRoot = options.pluginsRoot ?? config.pluginsRoot;
    const pluginRegistryUrl =
      options.pluginRegistryUrl ?? setup.env.TRIAGEAI_PLUGIN_REGISTRY ?? config.pluginRegistryUrl;
    const pluginKeys =
      options.pluginKeys ??
      parsePluginKeys(setup.env.TRIAGEAI_PLUGIN_PUBLIC_KEYS ?? config.pluginPublicKeys);

    // Never mutate a caller-provided capability bag: tests reuse one object
    // across app instances, and a leaked registry would point at a closed DB.
    let capabilities: Capabilities | undefined =
      options.capabilities === undefined ? undefined : { ...options.capabilities };

    async function loadPluginSet(): Promise<{
      modules: Record<string, TriageModule>;
      overlay: { modules: Record<string, { enabled: boolean }> };
      versions: Record<string, string>;
    }> {
      const installed = await loadInstalledPlugins(pluginsRoot, KERNEL_API_VERSION);
      const enabled = await pluginStore.enabledMap();
      const modules: Record<string, TriageModule> = { ...MODULES };
      const overlay: Record<string, { enabled: boolean }> = {};
      const versions: Record<string, string> = {};
      for (const plugin of installed) {
        if (modules[plugin.manifest.id]) continue; // first-party id wins
        modules[plugin.manifest.id] = plugin.module;
        overlay[plugin.manifest.id] = { enabled: enabled.get(plugin.manifest.id) ?? false };
        versions[plugin.manifest.id] = plugin.manifest.version;
      }
      return { modules, overlay: { modules: overlay }, versions };
    }

    interface Generation {
      kernel: Kernel;
      modules: Record<string, TriageModule>;
      versions: Record<string, string>;
      config: ReturnType<typeof buildKernelConfig>;
    }

    async function bootGeneration(): Promise<Generation> {
      const pluginSet = await loadPluginSet();
      // Re-read the overlay on every generation so setup "Add" / "Remove" /
      // "Reset and erase" take effect on soft-reload without a restart.
      const latestOverlay = runtime.store ? await runtime.store.latestOverlay() : null;
      const fileWithOverlay = latestOverlay
        ? applyConfigOverlay(fileConfig, latestOverlay.overlay)
        : fileConfig;
      const effectiveFile = applyConfigOverlay(fileWithOverlay, pluginSet.overlay);
      const nextConfig = buildKernelConfig(effectiveFile, setup.env as NodeJS.ProcessEnv);
      const caps = (capabilities ??= {
        ...(options.capabilities ??
          createCapabilities(nextConfig, config.aiServiceUrl, database, modelRegistry)),
      });
      caps.modelRegistry ??= modelRegistry;
      caps.cache ??= new MemoryCache();
      caps.egress ??= new EgressClient(database, [...(nextConfig.egress?.allowlist ?? [])]);
      caps.blobStore ??= new FilesystemBlobStore(
        process.env.TRIAGEAI_BLOB_ROOT ??
          resolve(process.env.TRIAGEAI_DATA_DIR ?? process.cwd(), 'data/blobs'),
      );
      caps.systemStatus ??= {
        status: async () =>
          systemReads.status(await connectedFacts()) as Promise<Record<string, unknown>>,
        uptime: async () => {
          const snapshot = (await systemReads.status(await connectedFacts())) as {
            asOf?: string;
            uptime?: Record<string, unknown>;
          };
          return { asOf: snapshot.asOf, ...(snapshot.uptime ?? {}) };
        },
        storage: async () => {
          const snapshot = (await systemReads.status(await connectedFacts())) as {
            asOf?: string;
            storage?: Record<string, unknown> | null;
          };
          return { asOf: snapshot.asOf, ...(snapshot.storage ?? {}) };
        },
      };
      const nextKernel = await bootKernel({
        config: nextConfig,
        database,
        logger: kernelLogger,
        capabilities: caps,
        modules: pluginSet.modules,
        env: setup.env,
      });
      liveKernel = nextKernel;
      registerSystemTools(nextKernel, systemReads);
      nextKernel.events.subscribe('chat.skill.changed', async () => {
        await syncSkillMirror(nextKernel).catch((err: unknown) =>
          kernelLogger.warn(
            { err: (err as Error).message },
            'skill KB mirror sync failed; the skill write is unaffected',
          ),
        );
      });
      return {
        kernel: nextKernel,
        modules: pluginSet.modules,
        versions: pluginSet.versions,
        config: nextConfig,
      };
    }

    let generation: Generation;
    try {
      generation = await bootGeneration();
    } catch (err) {
      if (runtime.state === 'applied') await recoverFailedApply(runtime, err, kernelLogger);
      await database.close();
      throw err;
    }

    const activeRegistry =
      capabilities?.modelRegistry instanceof DbModelRegistry
        ? capabilities.modelRegistry
        : modelRegistry;
    generation.kernel.tools.setReadOnly((await getControls(database)).readOnly);
    app.decorate('kernel', generation.kernel);

    let retentionTimer: NodeJS.Timeout | undefined;
    let uptimeMaintenanceTimer: NodeJS.Timeout | undefined;
    if (generation.kernel.config.retention?.enabled) {
      retentionTimer = setInterval(
        () => {
          void generation.kernel
            .runRetention()
            .catch((err: unknown) =>
              kernelLogger.error({ err: (err as Error).message }, 'retention pass failed'),
            );
        },
        generation.kernel.config.retention.intervalHours * 60 * 60 * 1000,
      );
      retentionTimer.unref();
    }

    if (config.nodeEnv !== 'test') {
      await recordBoot(database).catch((err: unknown) =>
        kernelLogger.warn({ err: (err as Error).message }, 'could not record API boot'),
      );
      void runUptimeMaintenance(database).catch((err: unknown) =>
        kernelLogger.warn({ err: (err as Error).message }, 'uptime maintenance failed'),
      );
      uptimeMaintenanceTimer = setInterval(
        () => {
          void runUptimeMaintenance(database).catch((err: unknown) =>
            kernelLogger.warn({ err: (err as Error).message }, 'uptime maintenance failed'),
          );
        },
        24 * 60 * 60 * 1000,
      );
      uptimeMaintenanceTimer.unref();
    }

    const stopUptimeProbes =
      config.nodeEnv === 'test'
        ? () => undefined
        : startUptimeProbes(database, () =>
            uptimeTargets(generation.kernel.config, config.aiServiceUrl),
          );
    // Update checks are once per two weeks (state is checked first), never in tests.
    if (config.nodeEnv !== 'test') {
      void checkForUpdate(generation.kernel).catch((err: unknown) =>
        kernelLogger.warn({ err: (err as Error).message }, 'update check failed'),
      );
    }

    // Approval expiry (Phase 18.3): a host-owned sweep, no module timer.
    const approvalTimer = setInterval(
      () => {
        void new ApprovalStore(database)
          .expireDue()
          .then((expired) => {
            if (expired.length > 0) {
              kernelLogger.warn({ count: expired.length }, 'approvals expired');
            }
          })
          .catch((err: unknown) =>
            kernelLogger.error({ err: (err as Error).message }, 'approval expiry failed'),
          );
      },
      60 * 60 * 1000,
    );
    approvalTimer.unref();

    await finishSetupBoot(runtime, setup.fresh, kernelLogger, (line) =>
      // The token must reach the operator even when logs are JSON or quiet.
      options.quiet ? undefined : process.stdout.write(`${line}\n`),
    );
    app.decorate('setupRuntime', runtime);

    app.post('/api/v1/system/base-memory/refresh', async () => {
      await baseMemory.sync(app.kernel ?? generation.kernel, 'manual');
      return { refreshed: true };
    });

    // The operational snapshot is time-sensitive (ADR-0057); refresh it on the
    // dashboard interval in addition to config-change debounces.
    if (config.nodeEnv !== 'test' && runtime.state === 'complete') {
      baseMemory.startPeriodic(() => app.kernel ?? generation.kernel);
    }

    // Base memory follows config changes. Tests trigger the service explicitly;
    // production boots and successful config writes debounce one sync.
    if (config.nodeEnv !== 'test' && runtime.state === 'complete') {
      baseMemory.schedule(generation.kernel, 'boot');
      app.addHook('onResponse', async (request, reply) => {
        if (request.method === 'GET' || reply.statusCode >= 400) return;
        if (runtime.state !== 'complete') return;
        const path = request.url.split('?')[0] ?? request.url;
        if (
          path.startsWith('/api/v1/setup/') ||
          path.startsWith('/api/v1/me/preferences') ||
          path.startsWith('/api/v1/connections') ||
          path.startsWith('/api/v1/system/data-policy') ||
          path.startsWith('/api/v1/system/controls') ||
          path.startsWith('/api/v1/system/modules') ||
          path.startsWith('/api/v1/plugins')
        ) {
          if (app.kernel) baseMemory.schedule(app.kernel, path);
        }
      });
    }

    // One reload at a time: generation N+1 must be ready before N is drained
    // (ADR-0026). Queue jobs survive the swap because workers are idempotent.
    let reloadInFlight: Promise<Generation> | null = null;
    const reload = async (reason: string): Promise<Generation> => {
      if (!reloadInFlight) {
        reloadInFlight = (async () => {
          kernelLogger.info({ reason }, 'soft-reloading kernel generation');
          const previous = generation;
          const next = await bootGeneration();
          generation = next;
          const latest = await runtime.store.latestOverlay();
          runtime.bootedOverlayVersion = latest?.version ?? null;
          next.kernel.tools.setReadOnly((await getControls(database)).readOnly);
          app.kernel = next.kernel;
          if (config.nodeEnv !== 'test') baseMemory.schedule(next.kernel, `reload:${reason}`);
          await previous.kernel.shutdown();
          kernelLogger.info({ reason, modules: next.kernel.modules }, 'soft-reload complete');
          return next;
        })().finally(() => {
          reloadInFlight = null;
        });
      }
      return reloadInFlight;
    };

    // Host routes read the current generation (soft-reload swaps `app.kernel`);
    // the proxy keeps the manifest and admin surfaces truthful after a plugin
    // install/enable/disable without re-binding any Fastify route.
    const dynamicKernel = new Proxy(generation.kernel, {
      get(_target, key) {
        const current = app.kernel ?? generation.kernel;
        const value = Reflect.get(current as object, key);
        return typeof value === 'function' ? value.bind(current) : value;
      },
    });

    registerHostRoutes(app, dynamicKernel, {
      modelRegistry: activeRegistry,
      setup: {
        runtime,
        file: fileConfig,
        modules: generation.modules,
        env: setup.env,
        authService,
        restartOnApply: options.restartOnApply ?? config.restartOnApply,
        restart:
          options.restart ??
          (() => {
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500).unref();
          }),
        reload: async (reason: string) => {
          await reload(reason);
        },
      },
      plugins: {
        store: pluginStore,
        registryUrl: pluginRegistryUrl,
        getEgress: () =>
          new EgressClient(database, [...(generation.kernel.config.egress?.allowlist ?? [])], {
            maxBytes: 50_000_000,
          }),
        pluginsRoot,
        trustedKeys: pluginKeys,
        currentVersions: () => generation.versions,
        reload,
      },
    });

    // Knowledge queued by the wizard is imported once the KB module runs.
    app.addHook('onReady', async () => {
      void processPendingImports(runtime, generation.kernel, kernelLogger).catch((err: unknown) =>
        kernelLogger.error({ err: (err as Error).message }, 'setup imports failed'),
      );
    });

    app.addHook('onClose', async () => {
      if (retentionTimer) clearInterval(retentionTimer);
      if (uptimeMaintenanceTimer) clearInterval(uptimeMaintenanceTimer);
      baseMemory.stopPeriodic();
      stopUptimeProbes();
      clearInterval(approvalTimer);
      await generation.kernel.shutdown();
      await database.close();
    });
  }

  return app;
}

export type { Kernel, RouteRequest };
