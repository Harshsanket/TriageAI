/**
 * Plugin administration (Phase 12, ADR-0026): install verified first-party or
 * admin-trusted packages, enable/disable without a restart, and uninstall an
 * explicitly disabled plugin. Every mutation reloads the kernel generation.
 */
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  conflict,
  diffPermissions,
  normalizePermissions,
  invalid,
  notFound,
  policyBlocked,
  uninstallPluginVersion,
} from '@triageai/kernel';
import type { Kernel, TrustedPluginKey } from '@triageai/kernel';

import type { EgressClient } from '../services/egress.js';

import {
  chooseRegistryEntry,
  fetchRegistryIndex,
  installFromRegistry,
  PluginStore,
} from '../services/plugins.js';
import { writeAudit } from '../services/audit.js';
import { getControls } from '../services/controls.js';

export const KERNEL_API_VERSION = '1.0.0';

export function parsePluginKeys(raw: string | undefined): TrustedPluginKey[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, publicKey] = entry.split(':');
      if (!id || !publicKey) return null;
      return { id, publicKey };
    })
    .filter((entry): entry is TrustedPluginKey => entry !== null);
}

export interface PluginRouteDeps {
  store: PluginStore;
  registryUrl: string;
  /** The live egress client (allowlist follows kernel soft-reloads). */
  getEgress: () => EgressClient;
  pluginsRoot: string;
  trustedKeys: TrustedPluginKey[];
  currentVersions: () => Record<string, string>;
  reload: (reason: string) => Promise<unknown>;
}

const InstallBody = z
  .object({
    id: z.string().min(1),
    version: z.string().optional(),
    allowDowngrade: z.boolean().default(false),
    /** Approve a widened permission manifest explicitly (ADR-0054 §2). */
    approveGrants: z.boolean().default(false),
  })
  .strict();

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
};

export function registerPluginRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  deps: PluginRouteDeps,
): void {
  app.get('/api/v1/plugins', async () => {
    const installed = await deps.store.list();
    const versions = deps.currentVersions();
    let available: unknown[] = [];
    if (deps.registryUrl !== 'off') {
      const index = await fetchRegistryIndex(deps.registryUrl, deps.getEgress()).catch(() => null);
      available =
        index?.plugins.map((entry) => ({
          id: entry.id,
          version: entry.version,
          kernelApi: entry.kernelApi,
          url: entry.url,
        })) ?? [];
    }
    return {
      installed: installed.map((row) => ({
        ...row,
        loadedVersion: versions[row.id] ?? null,
      })),
      available,
      registry: deps.registryUrl === 'off' ? 'off' : 'configured',
      trustedKeys: deps.trustedKeys.map((key) => key.id),
    };
  });

  app.post('/api/v1/plugins/install', async (request) => {
    const controls = await getControls(kernel.database);
    if (controls.pluginInstallsBlocked) {
      throw policyBlocked('plugin installs are blocked by the kill switch');
    }
    const body = InstallBody.parse(request.body ?? {});
    const actor = request.principal?.email ?? null;
    try {
      const approved = await kernel.grantStore.get(body.id);
      const plugin = await installFromRegistry({
        id: body.id,
        version: body.version,
        currentVersion: deps.currentVersions()[body.id],
        allowDowngrade: body.allowDowngrade,
        registryUrl: deps.registryUrl,
        pluginsRoot: deps.pluginsRoot,
        trustedKeys: deps.trustedKeys,
        kernelApiVersion: KERNEL_API_VERSION,
        actor,
        egress: deps.getEgress(),
      });
      const diff = diffPermissions(
        plugin.manifest.id,
        approved?.version ?? null,
        plugin.manifest.version,
        approved?.permissions ?? null,
        normalizePermissions(plugin.module.permissions ?? {}),
      );
      if (approved && diff.added.length > 0 && !body.approveGrants) {
        throw policyBlocked(
          `plugin ${plugin.manifest.id}@${plugin.manifest.version} widens its grants; re-install with approveGrants=true after reviewing the diff`,
          { diff },
        );
      }
      await kernel.grantStore.approve(plugin.module, actor);
      if (diff.added.length > 0 || diff.removed.length > 0) {
        await writeAudit(kernel.database, {
          actor,
          action: 'module.grants.approved',
          subject: plugin.manifest.id,
          payload: { version: plugin.manifest.version, diff },
        });
      }
      await deps.store.record(plugin, actor, deps.trustedKeys[0]?.id ?? null);
      await deps.reload(`install ${plugin.manifest.id}@${plugin.manifest.version}`);
      return {
        installed: {
          id: plugin.manifest.id,
          version: plugin.manifest.version,
          sha256: plugin.sha256,
          enabled: false,
        },
      };
    } catch (err) {
      await writeAudit(kernel.database, {
        actor,
        action: 'plugin.install_failed',
        subject: body.id,
        payload: { error: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
  });

  app.post('/api/v1/plugins/:id/enable', async (request) => {
    const { id } = request.params as { id: string };
    const rows = (await deps.store.list()).find((row) => row.id === id);
    if (!rows) throw notFound(`plugin ${id} is not installed`);
    await deps.store.setEnabled(id, true, request.principal?.email ?? null);
    await deps.reload(`enable ${id}`);
    return { id, enabled: true };
  });

  app.post('/api/v1/plugins/:id/disable', async (request) => {
    const { id } = request.params as { id: string };
    const rows = (await deps.store.list()).find((row) => row.id === id);
    if (!rows) throw notFound(`plugin ${id} is not installed`);
    await deps.store.setEnabled(id, false, request.principal?.email ?? null);
    await deps.reload(`disable ${id}`);
    return { id, enabled: false };
  });

  app.delete('/api/v1/plugins/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = (await deps.store.list()).find((entry) => entry.id === id);
    if (!row) throw notFound(`plugin ${id} is not installed`);
    if (row.enabled) throw conflict(`plugin ${id} is enabled; disable it before uninstalling`);
    await kernel.uninstallModule(id).catch(() => ({ dropped: [] }));
    await uninstallPluginVersion(deps.pluginsRoot, id, row.version);
    await deps.store.remove(id, request.principal?.email ?? null);
    await deps.reload(`uninstall ${id}`);
    return { id, uninstalled: true };
  });

  // Dynamic web bundles (ADR-0027). Immutable per (id, version); resolved under
  // the plugin volume with a path-traversal guard.
  app.get('/plugins/:id/:version/*', async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string };
    const wildcard = (request.params as Record<string, string>)['*'] ?? '';
    if (!/^[a-z0-9-]+$/.test(id) || !/^\d+\.\d+\.\d+/.test(version)) {
      throw invalid('invalid plugin bundle path');
    }
    const root = resolve(deps.pluginsRoot, id, version);
    const target = normalize(join(root, wildcard));
    if (!target.startsWith(`${root}/`)) throw invalid('invalid plugin bundle path');
    try {
      const content = await readFile(target);
      const extension = target.slice(target.lastIndexOf('.'));
      reply.header('content-type', CONTENT_TYPES[extension] ?? 'application/octet-stream');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(content);
    } catch {
      throw notFound(`plugin bundle ${id}@${version}/${wildcard} not found`);
    }
  });

  app.get('/api/v1/plugins/available', async () => {
    if (deps.registryUrl === 'off') return { plugins: [] };
    const index = await fetchRegistryIndex(deps.registryUrl, deps.getEgress());
    return {
      plugins: index.plugins.map((entry) => ({
        id: entry.id,
        version: entry.version,
        kernelApi: entry.kernelApi,
        url: entry.url,
      })),
    };
  });

  app.get('/api/v1/plugins/latest/:id', async (request) => {
    const { id } = request.params as { id: string };
    const index = await fetchRegistryIndex(deps.registryUrl, deps.getEgress());
    const entry = chooseRegistryEntry(index, id);
    if (!entry) throw notFound(`plugin ${id} is not in the registry`);
    return entry;
  });
}
