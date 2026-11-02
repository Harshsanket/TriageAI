/**
 * `/api/v1/setup/*` — the first-run wizard and the `/config` page (ADR-0024).
 * While setup is pending these routes accept the one-time setup token; after
 * setup they are admin-only like the rest of the system surface.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import {
  AppearanceDefaultsUpdateSchema,
  SetupAnswersSchema,
  SetupInterfaceSchema,
  type HardwareProfile,
  type ParsedSetupAnswers,
  type SetupPlan,
} from '@triageai/contracts';
import { AppError, parseConfigOverlay } from '@triageai/kernel';
import type { ConfigFile, Kernel, TriageModule } from '@triageai/kernel';

import { config } from '../platform/config.js';
import { redactValue } from '../platform/redact.js';
import type { AuthService } from '../platform/auth/service.js';
import { OllamaGenerator, OpenAICompatibleGenerator } from '../services/capabilities.js';
import {
  JWT_SECRET_NAME,
  processPendingImports,
  writeAuthSetting,
  type SetupRuntime,
} from './boot.js';
import { presetModels, searchHuggingFace } from './catalog.js';
import { probeHardware } from './hardware.js';
import { agentDefaults } from './agents.js';
import { mergeInterfacesOverlay, planSetup, SECRET_ENV } from './plan.js';
import { SecretStore } from './secrets.js';

export interface SetupRouteDeps {
  runtime: SetupRuntime;
  /** Config file as loaded (before the overlay), for planning and the diff view. */
  file: ConfigFile;
  modules: Record<string, TriageModule>;
  env: Record<string, string | undefined>;
  authService: AuthService;
  /** Exit after apply so a supervisor (compose `restart:`) boots the new config. */
  restartOnApply: boolean;
  /** Apply the latest overlay without a process restart (Phase 12 soft reload). */
  reload?: (reason: string) => Promise<unknown>;
  /** Trigger a process restart so a supervisor boots the latest overlay. */
  restart?: () => void;
}

const MODEL_NAME = /^[\w.:/-]{1,200}$/;
const HARDWARE_TTL_MS = 30_000;

const ModelSettingsSchema = z
  .object({
    generator: z
      .object({
        adapter: z.enum(['ollama', 'lmstudio', 'openai_compatible_local']),
        model: z.string().regex(MODEL_NAME),
        baseUrl: z.string().url().optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().positive().max(4096).optional(),
        timeoutMs: z.number().int().min(1000).max(600_000).optional(),
      })
      .partial()
      .strict()
      .optional(),
    chat: z
      .object({
        maxAnswerTokens: z.number().int().positive().max(2048),
        knowledgeMode: z.enum(['prefer', 'only']),
      })
      .partial()
      .strict()
      .optional(),
    retriever: z
      .object({
        threshold: z.number().min(0).max(1),
        margin: z.number().min(0).max(1),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export function registerSetupRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  deps: SetupRouteDeps,
): void {
  const { runtime } = deps;
  const actorOf = (request: { principal?: { email: string } }) =>
    request.principal?.email ?? 'setup';

  let hardwareCache: { at: number; key: string; value: HardwareProfile } | null = null;
  const hardware = async (ollamaUrl?: string): Promise<HardwareProfile> => {
    const url = ollamaUrl ?? deps.env.TRIAGEAI_GENERATOR_BASE_URL ?? 'http://localhost:11434';
    if (
      hardwareCache &&
      hardwareCache.key === url &&
      Date.now() - hardwareCache.at < HARDWARE_TTL_MS
    ) {
      return hardwareCache.value;
    }
    const value = await probeHardware({ aiServiceUrl: config.aiServiceUrl, ollamaUrl: url });
    hardwareCache = { at: Date.now(), key: url, value };
    return value;
  };

  const plan = (answers: ParsedSetupAnswers): SetupPlan => {
    const result = planSetup(answers, deps.file, deps.modules, deps.env as NodeJS.ProcessEnv);
    if (result.secrets.length > 0 && !runtime.secrets.available) {
      result.problems.push(
        'Credentials were entered but the secret store is off: set TRIAGEAI_SECRET_KEY (32+ characters) or put them in the environment instead.',
      );
    }
    if (answers.access.authMode === 'required') {
      const hasSecret = Boolean(deps.env[JWT_SECRET_NAME]);
      if (!hasSecret && !runtime.secrets.available) {
        result.problems.push(
          'Sign-in needs a JWT secret: set AUTH_JWT_SECRET, or TRIAGEAI_SECRET_KEY so one can be generated and stored.',
        );
      }
      if (runtime.authModeSource === 'env' && runtime.authMode !== 'required') {
        result.warnings.push('AUTH_MODE is set in the environment and overrides this choice.');
      }
    }
    return result;
  };

  app.get('/api/v1/setup/status', async () => {
    const latest = await runtime.store.latestOverlay();
    return {
      state: runtime.state,
      tokenRequired: runtime.state === 'pending' && runtime.enabled,
      restartRequired:
        runtime.state === 'applied' || (latest?.version ?? null) !== runtime.bootedOverlayVersion,
      lastError: await runtime.store.lastError(),
      overlayVersion: runtime.bootedOverlayVersion,
      secretStoreAvailable: runtime.secrets.available,
    };
  });

  app.get('/api/v1/setup/hardware', async (request) => {
    const { ollamaUrl } = z
      .object({ ollamaUrl: z.string().url().optional() })
      .parse(request.query ?? {});
    return hardware(ollamaUrl);
  });

  app.get('/api/v1/setup/models', async (request) => {
    const query = z
      .object({
        kind: z.enum(['generation', 'embedding']).default('generation'),
        q: z.string().max(100).optional(),
      })
      .parse(request.query ?? {});
    const profile = await hardware();
    if (!query.q) return { models: await presetModels(profile, query.kind), hardware: profile };
    try {
      return { models: await searchHuggingFace(query.q, query.kind, profile), hardware: profile };
    } catch (err) {
      throw new AppError('setup.CATALOG_UNAVAILABLE', (err as Error).message, undefined, 502);
    }
  });

  // Ollama only: stream `ollama pull` progress to the page as server-sent events.
  app.post('/api/v1/setup/models/pull', async (request, reply) => {
    const body = z
      .object({ baseUrl: z.string().url().optional(), model: z.string().regex(MODEL_NAME) })
      .parse(request.body);
    const base = (body.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '');
    const upstream = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: body.model, stream: true }),
    }).catch((err: Error) => {
      throw new AppError(
        'setup.RUNTIME_UNREACHABLE',
        `Ollama at ${base}: ${err.message}`,
        undefined,
        502,
      );
    });
    if (!upstream.ok || !upstream.body) {
      throw new AppError(
        'setup.PULL_FAILED',
        `Ollama answered ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`,
        undefined,
        502,
      );
    }
    await streamNdjsonAsSse(reply, upstream.body);
    return reply;
  });

  app.post('/api/v1/setup/llm/test', async (request) => {
    const body = z
      .object({
        runtime: z.enum(['ollama', 'lmstudio', 'openai-compatible']),
        baseUrl: z.string().url().optional(),
        model: z.string().regex(MODEL_NAME),
      })
      .parse(request.body);
    const generator =
      body.runtime === 'ollama'
        ? new OllamaGenerator(body.baseUrl ?? 'http://localhost:11434', body.model)
        : new OpenAICompatibleGenerator(
            body.baseUrl ?? 'http://localhost:1234/v1',
            body.model,
            'local',
          );
    const started = Date.now();
    try {
      const result = await generator.generate('Reply with exactly one word: ready', {
        maxTokens: 16,
        signal: AbortSignal.timeout(60_000),
      });
      return {
        ok: true,
        latencyMs: Date.now() - started,
        text: result.text.slice(0, 200),
        modelVersion: result.modelVersion,
      };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message };
    }
  });

  app.get('/api/v1/setup/model-settings', async () => {
    const runningGenerator = (kernel.config.capabilities.generator ?? {}) as Record<
      string,
      unknown
    >;
    const runningRetriever = (kernel.config.capabilities.retriever ?? {}) as Record<
      string,
      unknown
    >;
    const runningChat = kernel.config.modules.chat?.options as
      | {
          maxAnswerTokens?: number;
          collection?: string;
          retrievalLimit?: number;
          knowledgeMode?: 'prefer' | 'only';
        }
      | undefined;
    const latest = await runtime.store.latestOverlay();
    const overlay = (latest?.overlay ?? {}) as Record<string, unknown>;
    const overlayCapabilities = (overlay.capabilities ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const overlayModules = (overlay.modules ?? {}) as Record<
      string,
      { options?: Record<string, unknown> }
    >;
    const overlayChat = overlayModules.chat?.options ?? {};
    const generator = { ...runningGenerator, ...(overlayCapabilities.generator ?? {}) };
    const retriever = { ...runningRetriever, ...(overlayCapabilities.retriever ?? {}) };
    const chat = { ...(runningChat ?? {}), ...overlayChat };
    return {
      generator: {
        adapter: generator.adapter ?? 'ollama',
        model: generator.model ?? '',
        baseUrl: generator.baseUrl ?? '',
        temperature: Number(generator.temperature ?? 0.2),
        maxTokens: Number(generator.maxTokens ?? chat?.maxAnswerTokens ?? 384),
        timeoutMs: Number(generator.timeoutMs ?? 120_000),
      },
      chat: {
        maxAnswerTokens: chat?.maxAnswerTokens ?? 384,
        knowledgeMode: chat?.knowledgeMode ?? 'prefer',
      },
      retriever: {
        threshold: Number(retriever.threshold ?? 0.35),
        margin: Number(retriever.margin ?? 0.05),
      },
      overlayVersion: runtime.bootedOverlayVersion,
      latestOverlayVersion: latest?.version ?? null,
      restartRequired:
        runtime.state === 'applied' || (latest?.version ?? null) !== runtime.bootedOverlayVersion,
    };
  });

  app.put('/api/v1/setup/model-settings', async (request) => {
    const body = ModelSettingsSchema.parse(request.body ?? {});
    const actor = actorOf(request);
    const latest = await runtime.store.latestOverlay();
    const base = (latest?.overlay ?? {}) as Record<string, unknown>;
    const baseCapabilities = (base.capabilities ?? {}) as Record<string, Record<string, unknown>>;
    const baseModules = (base.modules ?? {}) as Record<string, Record<string, unknown>>;
    const overlay: Record<string, unknown> = { ...base };
    if (body.generator) {
      overlay.capabilities = {
        ...baseCapabilities,
        generator: { ...(baseCapabilities.generator ?? {}), ...body.generator },
      };
    }
    if (body.retriever) {
      overlay.capabilities = {
        ...((overlay.capabilities as Record<string, unknown>) ?? baseCapabilities),
        retriever: { ...(baseCapabilities.retriever ?? {}), ...body.retriever },
      };
    }
    if (body.chat) {
      overlay.modules = {
        ...baseModules,
        chat: {
          ...(baseModules.chat ?? {}),
          options: {
            ...((baseModules.chat?.options as Record<string, unknown> | undefined) ?? {}),
            ...body.chat,
          },
        },
      };
    }
    parseConfigOverlay(overlay);
    const version = await runtime.store.writeOverlay(
      overlay,
      actor,
      'model and retrieval settings',
    );
    return {
      saved: true,
      version,
      restartRequired: version !== runtime.bootedOverlayVersion,
    };
  });

  // Model capabilities are built once per process, so they need a real
  // restart, not the Phase-12 soft reload: exit and let the supervisor boot
  // the latest overlay.
  app.post('/api/v1/setup/restart', async () => {
    if (runtime.state === 'pending') {
      throw new AppError('setup.NOT_COMPLETE', 'finish first-run setup first', undefined, 409);
    }
    if (deps.restart) deps.restart();
    else setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500).unref();
    return { restarted: false, restarting: true };
  });

  app.post('/api/v1/setup/reset', async (request) => {
    const body = z
      .object({ confirm: z.literal('RESET') })
      .strict()
      .parse(request.body ?? {});
    void body;
    const actor = actorOf(request);
    const version = await runtime.store.writeOverlay({}, actor, 'reset configuration overlay');
    return {
      reset: true,
      version,
      restartRequired: version !== runtime.bootedOverlayVersion,
    };
  });

  const lifecycle = async (
    overlay: Record<string, unknown>,
    actor: string,
    note: string,
  ): Promise<{ version: number; reloaded: boolean }> => {
    parseConfigOverlay(overlay);
    const version = await runtime.store.writeOverlay(overlay, actor, note);
    let reloaded = false;
    if (deps.reload) {
      await deps.reload(note);
      runtime.bootedOverlayVersion = version;
      reloaded = true;
    }
    return { version, reloaded };
  };

  app.post('/api/v1/setup/add', async (request) => {
    if (runtime.state !== 'complete') {
      throw new AppError('setup.NOT_COMPLETE', 'finish first-run setup first', undefined, 409);
    }
    const body = z
      .object({ interfaces: z.array(SetupInterfaceSchema).min(1).max(7) })
      .strict()
      .parse(request.body);
    const latest = await runtime.store.latestOverlay();
    const merged = mergeInterfacesOverlay(
      (latest?.overlay ?? {}) as Record<string, unknown>,
      body.interfaces,
      [],
      deps.modules,
    );
    const mergedCapabilities = (merged.overlay.capabilities ?? {}) as Record<string, unknown>;
    if (
      (body.interfaces.includes('chatbot') || body.interfaces.includes('doc-assistant')) &&
      !mergedCapabilities.generator &&
      !kernel.config.capabilities.generator
    ) {
      merged.problems.push(
        'This interface writes answers, so it needs an LLM. Configure a model on /config first.',
      );
    }
    if (merged.problems.length > 0) {
      throw new AppError('setup.PLAN_INVALID', merged.problems.join(' '), merged.problems, 422);
    }
    const result = await lifecycle(merged.overlay, actorOf(request), 'add interfaces to setup');
    return {
      added: body.interfaces,
      enabledModules: merged.enabledModules,
      agents: merged.agents,
      ...result,
    };
  });

  app.post('/api/v1/setup/remove', async (request) => {
    if (runtime.state !== 'complete') {
      throw new AppError('setup.NOT_COMPLETE', 'finish first-run setup first', undefined, 409);
    }
    const body = z
      .object({ interfaces: z.array(SetupInterfaceSchema).min(1).max(7) })
      .strict()
      .parse(request.body);
    const latest = await runtime.store.latestOverlay();
    const merged = mergeInterfacesOverlay(
      (latest?.overlay ?? {}) as Record<string, unknown>,
      [],
      body.interfaces,
      deps.modules,
    );
    const result = await lifecycle(
      merged.overlay,
      actorOf(request),
      'remove interfaces from setup',
    );
    return {
      removed: body.interfaces,
      enabledModules: merged.enabledModules,
      ...result,
    };
  });

  app.post('/api/v1/setup/erase', async (request) => {
    const body = z
      .object({ confirm: z.literal('TriageAI') })
      .strict()
      .parse(request.body ?? {});
    void body;
    const actor = actorOf(request);
    const overlay = {
      interfaces: [],
      modules: Object.fromEntries(Object.keys(deps.modules).map((id) => [id, { enabled: false }])),
    };
    const result = await lifecycle(overlay, actor, 'reset and erase setup');
    const uninstalled: string[] = [];
    if (result.reloaded) {
      for (const id of Object.keys(deps.modules)) {
        try {
          await kernel.uninstallModule(id);
          uninstalled.push(id);
        } catch (err) {
          if ((err as AppError).code !== 'kernel.NOT_FOUND') throw err;
        }
      }
      await kernel.database.query(`DELETE FROM datasets`).catch(() => undefined);
      await kernel.database.query(`DELETE FROM candidate_examples`).catch(() => undefined);
      await kernel.database.query(`DELETE FROM user_skills`).catch(() => undefined);
    }
    await runtime.store.saveDraft({}, actor);
    await kernel.database.query(`DELETE FROM setup_imports`).catch(() => undefined);
    await runtime.secrets.clear(actor);
    runtime.state = 'pending';
    await runtime.store.setState('pending', actor);
    runtime.token.revoke();
    return {
      erased: true,
      uninstalled,
      restartRequired: true,
      tokenRequired: true,
    };
  });

  app.put('/api/v1/setup/appearance-defaults', async (request) => {
    const body = AppearanceDefaultsUpdateSchema.parse(request.body ?? {});
    const latest = await runtime.store.latestOverlay();
    const base = (latest?.overlay ?? {}) as Record<string, unknown>;
    const appearance = (base.appearance ?? {}) as { defaults?: Record<string, unknown> };
    const overlay = {
      ...base,
      appearance: { ...appearance, defaults: { ...(appearance.defaults ?? {}), ...body } },
    };
    parseConfigOverlay(overlay);
    const version = await runtime.store.writeOverlay(
      overlay,
      actorOf(request),
      'appearance defaults',
    );
    return { saved: true, version };
  });

  app.get('/api/v1/setup/draft', async () => ({ draft: await runtime.store.draft() }));

  app.put('/api/v1/setup/draft', async (request) => {
    // Drafts are partial by nature; only bound the size. Never store secrets.
    const draft = z.record(z.unknown()).parse(request.body ?? {});
    if (JSON.stringify(draft).length > 2_000_000) {
      throw new AppError('setup.DRAFT_TOO_LARGE', 'draft is larger than 2 MB', undefined, 413);
    }
    const safe = redactValue(draft) as Record<string, unknown>;
    await runtime.store.saveDraft(safe, actorOf(request));
    return { saved: true };
  });

  app.get('/api/v1/setup/agent-defaults', async (request) => {
    const query = z
      .object({
        interfaces: z.string().min(1).max(300),
        existing: z.string().max(2000).optional(),
        colors: z.string().max(2000).optional(),
      })
      .parse(request.query ?? {});
    const interfaces = query.interfaces
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return {
      agents: agentDefaults(
        interfaces,
        (query.existing ?? '').split(',').filter(Boolean),
        (query.colors ?? '').split(',').filter(Boolean),
      ),
    };
  });

  app.post('/api/v1/setup/plan', async (request) => plan(SetupAnswersSchema.parse(request.body)));

  app.post('/api/v1/setup/apply', async (request, reply) => {
    const answers = SetupAnswersSchema.parse(request.body);
    const result = plan(answers);
    if (result.problems.length > 0) {
      return reply.status(422).send({ applied: false, plan: result });
    }
    const actor = actorOf(request);

    if (answers.integrations.githubToken) {
      await runtime.secrets.set(SECRET_ENV.githubToken, answers.integrations.githubToken, actor);
    }
    if (answers.integrations.slackWebhookUrl) {
      await runtime.secrets.set(
        SECRET_ENV.slackWebhookUrl,
        answers.integrations.slackWebhookUrl,
        actor,
      );
    }
    if (answers.access.authMode === 'required' && !deps.env[JWT_SECRET_NAME]) {
      await runtime.secrets.set(JWT_SECRET_NAME, randomBytes(48).toString('base64url'), actor);
    }
    await writeAuthSetting(kernel.database, answers.access.authMode, actor);

    let adminCreated = false;
    if (answers.access.admin) {
      try {
        await deps.authService.register(answers.access.admin);
        adminCreated = true;
      } catch (err) {
        if ((err as AppError).code !== 'auth.REGISTRATION_CLOSED') throw err;
        result.warnings.push('An account already exists, so no new admin was created.');
      }
    }

    const queued = await runtime.store.queueImports(
      answers.knowledge.documents,
      answers.knowledge.autoApprove,
    );
    const overlayVersion = await runtime.store.writeOverlay(result.overlay, actor, 'setup wizard');
    if (runtime.state === 'pending') {
      runtime.state = 'applied';
      await runtime.store.setState('applied', actor);
      // The token's job is done; nothing else is reachable until restart.
      runtime.token.revoke();
    }
    await runtime.store.saveDraft({}, actor);

    if (deps.restartOnApply) {
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500).unref();
    }
    return {
      applied: true,
      plan: result,
      overlayVersion,
      adminCreated,
      importsQueued: queued,
      restartRequired: true,
      restarting: deps.restartOnApply,
    };
  });

  app.get('/api/v1/setup/config/effective', async () => {
    const latest = await runtime.store.latestOverlay();
    return redactValue({
      bootedOverlayVersion: runtime.bootedOverlayVersion,
      latestOverlay: latest,
      history: await runtime.store.overlayHistory(),
      file: deps.file,
      running: {
        profile: kernel.config.profile,
        modules: kernel.config.modules,
        capabilities: kernel.config.capabilities,
        queue: kernel.config.queue,
      },
      authMode: runtime.authMode,
      authModeSource: runtime.authModeSource,
    });
  });

  app.get('/api/v1/setup/secrets', async () => ({
    available: runtime.secrets.available,
    secrets: await runtime.secrets.list(),
  }));

  app.put('/api/v1/setup/secrets/:name', async (request) => {
    const { name } = request.params as { name: string };
    if (!SecretStore.isValidName(name)) {
      throw new AppError(
        'setup.INVALID_SECRET_NAME',
        'use an UPPER_SNAKE_CASE env-var name',
        undefined,
        400,
      );
    }
    if (!runtime.secrets.available) {
      throw new AppError(
        'setup.SECRET_STORE_OFF',
        'set TRIAGEAI_SECRET_KEY (32+ characters)',
        undefined,
        409,
      );
    }
    const body = z.object({ value: z.string().min(1).max(10_000) }).parse(request.body);
    await runtime.secrets.set(name, body.value, actorOf(request));
    return { name, saved: true, restartRequired: true };
  });

  app.post('/api/v1/setup/imports/retry', async () => {
    await kernel.database.query(
      `UPDATE setup_imports SET status = 'pending', error = NULL WHERE status = 'failed'`,
    );
    return processPendingImports(runtime, kernel, {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    });
  });
}

async function streamNdjsonAsSse(
  reply: FastifyReply,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) reply.raw.write(`data: ${line}\n\n`);
        newline = buffer.indexOf('\n');
      }
    }
    if (buffer.trim()) reply.raw.write(`data: ${buffer.trim()}\n\n`);
    reply.raw.write('event: done\ndata: {}\n\n');
  } catch (err) {
    reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
  } finally {
    reply.raw.end();
  }
}
