/**
 * Connected APIs (Phase 23.7): one list for every external API the app talks
 * to, with add/test/rotate/disable/remove. Custom connections live in
 * `settings.connections`; config-derived ones stay read-only and link to
 * `/config`.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { FastifyInstance } from 'fastify';
import type { Kernel } from '@triageai/kernel';
import { invalid } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';
import { EgressClient } from '../services/egress.js';
import type { SetupRuntime } from '../setup/boot.js';

const SETTINGS_KEY = 'connections';

interface StoredConnection {
  id: string;
  name: string;
  type: string;
  baseUrl: string;
  secretName: string | null;
  allowHost: boolean;
  disabled: boolean;
  createdAt: string;
}

interface ConnectionView {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  secretName: string | null;
  source: 'config' | 'custom';
  status: 'ready' | 'needs_secret' | 'disabled' | 'unreachable';
  allowlisted: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
  calls: number;
  errors: number;
  actions: string[];
}

const ConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: z.enum(['hosted-model', 'github', 'slack', 'smtp', 'mcp', 'source-plugin', 'custom']),
    baseUrl: z.string().url(),
    secretName: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,63}$/)
      .nullable()
      .optional(),
    secretValue: z.string().min(1).max(10_000).optional(),
    allowHost: z.boolean().default(false),
  })
  .strict();

async function readCustom(kernel: Kernel): Promise<StoredConnection[]> {
  const rows = await kernel.database
    .query<{ value: StoredConnection[] }>(`SELECT value FROM settings WHERE key = $1`, [
      SETTINGS_KEY,
    ])
    .catch(() => []);
  const value = rows[0]?.value;
  return Array.isArray(value) ? value : [];
}

async function writeCustom(
  kernel: Kernel,
  actor: string | null,
  connections: StoredConnection[],
): Promise<void> {
  await kernel.database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [SETTINGS_KEY, connections, actor ?? 'system'],
  );
}

function configConnections(kernel: Kernel, secretNames: Set<string>): ConnectionView[] {
  const views: ConnectionView[] = [];
  const allow = new Set(
    (kernel.config.egress?.allowlist ?? []).map((entry) => entry.host.toLowerCase()),
  );
  const hostAllowed = (url: string | null): boolean => {
    if (!url) return false;
    try {
      const host = new URL(url).hostname.toLowerCase();
      return [...allow].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    } catch {
      return false;
    }
  };
  const chat = kernel.config.capabilities.chatModel;
  if (chat) {
    const adapter = String(chat.adapter);
    const apiKeyEnv =
      (chat.apiKeyEnv as string | undefined) ??
      {
        anthropic: 'ANTHROPIC_API_KEY',
        openai: 'OPENAI_API_KEY',
        google: 'GOOGLE_API_KEY',
        openai_compatible: 'OPENAI_API_KEY',
      }[adapter] ??
      null;
    const baseUrl = (chat.baseUrl as string | undefined) ?? null;
    views.push({
      id: `config:chatmodel:${adapter}`,
      name: `${adapter} model`,
      type: 'hosted-model',
      baseUrl,
      secretName: apiKeyEnv,
      source: 'config',
      status: apiKeyEnv && !secretNames.has(apiKeyEnv) ? 'needs_secret' : 'ready',
      allowlisted: hostAllowed(baseUrl),
      lastSuccessAt: null,
      lastError: null,
      latencyMs: null,
      calls: 0,
      errors: 0,
      actions: ['test'],
    });
  }
  const modules = kernel.config.modules as Record<
    string,
    { enabled?: boolean; options?: Record<string, unknown> }
  >;
  const add = (
    id: string,
    name: string,
    type: string,
    secretName: string | null,
    baseUrl: string | null,
  ) => {
    views.push({
      id: `config:${id}`,
      name,
      type,
      baseUrl,
      secretName,
      source: 'config',
      status: secretName && !secretNames.has(secretName) ? 'needs_secret' : 'ready',
      allowlisted: hostAllowed(baseUrl),
      lastSuccessAt: null,
      lastError: null,
      latencyMs: null,
      calls: 0,
      errors: 0,
      actions: ['test'],
    });
  };
  if (modules['integrations-github']?.enabled) {
    add(
      'github',
      'GitHub',
      'github',
      String(modules['integrations-github'].options?.tokenEnv ?? 'GITHUB_TOKEN'),
      'https://api.github.com',
    );
  }
  if (modules['integrations-slack']?.enabled) {
    add(
      'slack',
      'Slack',
      'slack',
      String(modules['integrations-slack'].options?.webhookSecretEnv ?? 'SLACK_WEBHOOK_URL'),
      null,
    );
  }
  if (modules.emailer?.enabled) {
    add('smtp', 'SMTP', 'smtp', 'EMAIL_SMTP_PASS', null);
  }
  return views;
}

function customViews(stored: StoredConnection[], allow: Set<string>): ConnectionView[] {
  return stored.map((connection) => {
    let allowlisted = false;
    try {
      const host = new URL(connection.baseUrl).hostname.toLowerCase();
      allowlisted = [...allow].some((entry) => host === entry || host.endsWith(`.${entry}`));
    } catch {
      allowlisted = false;
    }
    return {
      id: connection.id,
      name: connection.name,
      type: connection.type,
      baseUrl: connection.baseUrl,
      secretName: connection.secretName,
      source: 'custom',
      status: connection.disabled ? 'disabled' : 'ready',
      allowlisted,
      lastSuccessAt: null,
      lastError: null,
      latencyMs: null,
      calls: 0,
      errors: 0,
      actions: ['test', 'rotate', 'disable', 'remove'],
    };
  });
}

export async function readConnections(
  kernel: Kernel,
  runtime: SetupRuntime,
): Promise<{ connections: ConnectionView[]; secrets: string[] }> {
  const secrets = await runtime.secrets.list();
  const names = new Set(secrets.map((entry) => entry.name));
  const stored = await readCustom(kernel);
  const allow = new Set(
    (kernel.config.egress?.allowlist ?? []).map((entry) => entry.host.toLowerCase()),
  );
  return {
    connections: [...configConnections(kernel, names), ...customViews(stored, allow)],
    secrets: [...names],
  };
}

export function registerConnectionRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  runtime: SetupRuntime,
): void {
  app.get('/api/v1/connections', async () => readConnections(kernel, runtime));

  app.post('/api/v1/connections', async (request) => {
    const body = ConnectionInputSchema.parse(request.body ?? {});
    const stored = await readCustom(kernel);
    if (stored.some((entry) => entry.name.toLowerCase() === body.name.toLowerCase())) {
      throw invalid(`a connection named ${body.name} already exists`);
    }
    if (body.secretValue) {
      if (!runtime.secrets.available) throw invalid('the secret store is unavailable');
      if (!body.secretName) throw invalid('secretName is required when a value is provided');
      await runtime.secrets.set(
        body.secretName,
        body.secretValue,
        request.principal?.email ?? 'system',
      );
    }
    const connection: StoredConnection = {
      id: randomUUID(),
      name: body.name,
      type: body.type,
      baseUrl: body.baseUrl,
      secretName: body.secretName ?? null,
      allowHost: body.allowHost,
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    await writeCustom(kernel, request.principal?.email ?? null, [...stored, connection]);
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'connection.created',
      subject: connection.id,
      payload: { name: connection.name, type: connection.type, allowHost: body.allowHost },
    });
    return { id: connection.id, saved: true, allowHost: body.allowHost };
  });

  app.post('/api/v1/connections/:id/test', async (request) => {
    const { id } = request.params as { id: string };
    const stored = await readCustom(kernel);
    const custom = stored.find((entry) => entry.id === id);
    const config = configConnections(kernel, new Set()).find((entry) => entry.id === id);
    const target = custom
      ? { baseUrl: custom.baseUrl, allowHost: custom.allowHost, name: custom.name }
      : config
        ? { baseUrl: config.baseUrl, allowHost: config.allowlisted, name: config.name }
        : null;
    if (!target?.baseUrl) throw invalid(`connection ${id} has no base URL to test`);
    let host: string;
    try {
      host = new URL(target.baseUrl).hostname;
    } catch {
      throw invalid(`connection ${id} has an invalid base URL`);
    }
    const allow = (kernel.config.egress?.allowlist ?? []).map((entry) => entry.host);
    const egress = new EgressClient(kernel.database, [
      ...allow.map((entry) => ({ host: entry, dataClass: 'internal' as const })),
      ...(target.allowHost ? [{ host, dataClass: 'internal' as const }] : []),
    ]);
    if (!egress.allows(target.baseUrl)) {
      throw invalid(
        `host ${host} is not on the egress allowlist; add it and retry with allowHost=true`,
      );
    }
    const started = Date.now();
    try {
      const response = await egress.fetch(
        target.baseUrl,
        { method: 'GET', signal: AbortSignal.timeout(5_000) },
        { purpose: `connection.test:${target.name}` },
      );
      return {
        ok: response.ok,
        status: response.status,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        status: null,
        latencyMs: Date.now() - started,
        error: (err as Error).message,
      };
    }
  });

  app.put('/api/v1/connections/:id/secret', async (request) => {
    const { id } = request.params as { id: string };
    const body = z
      .object({ value: z.string().min(1).max(10_000) })
      .strict()
      .parse(request.body ?? {});
    const stored = await readCustom(kernel);
    const connection = stored.find((entry) => entry.id === id);
    if (!connection?.secretName) throw invalid(`connection ${id} has no secret`);
    if (!runtime.secrets.available) throw invalid('the secret store is unavailable');
    await runtime.secrets.set(
      connection.secretName,
      body.value,
      request.principal?.email ?? 'system',
    );
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'connection.secret_rotated',
      subject: connection.id,
      payload: { secretName: connection.secretName },
    });
    return { rotated: true, restartRequired: true };
  });

  app.post('/api/v1/connections/:id/disable', async (request) => {
    const { id } = request.params as { id: string };
    const stored = await readCustom(kernel);
    const connection = stored.find((entry) => entry.id === id);
    if (!connection) throw invalid(`connection ${id} is config-derived and read-only`);
    connection.disabled = !connection.disabled;
    await writeCustom(kernel, request.principal?.email ?? null, stored);
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: connection.disabled ? 'connection.disabled' : 'connection.enabled',
      subject: connection.id,
    });
    return { disabled: connection.disabled };
  });

  app.delete('/api/v1/connections/:id', async (request) => {
    const { id } = request.params as { id: string };
    const stored = await readCustom(kernel);
    const connection = stored.find((entry) => entry.id === id);
    if (!connection) throw invalid(`connection ${id} is config-derived and read-only`);
    await writeCustom(
      kernel,
      request.principal?.email ?? null,
      stored.filter((entry) => entry.id !== id),
    );
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? null,
      action: 'connection.removed',
      subject: connection.id,
    });
    return { removed: true };
  });
}
