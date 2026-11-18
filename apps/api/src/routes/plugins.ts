/**
 * Plugin administration (Phase 12, ADR-0026): install verified first-party or
 * admin-trusted packages, enable/disable without a restart, and uninstall an
 * explicitly disabled plugin. Every mutation reloads the kernel generation.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

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
import type { Kernel, ModuleGrantRow, PackManifest, TrustedPluginKey } from '@triageai/kernel';
import { importPackContents, type ImportResult } from '@triageai/plugin-sdk';

import type { EgressClient } from '../services/egress.js';

import {
  choosePackRegistryEntry,
  chooseRegistryEntry,
  discardPluginVersionSnapshot,
  downloadPackArchive,
  fetchRegistryIndex,
  installFromRegistry,
  PackStore,
  PluginStore,
  removePluginVersion,
  restorePluginVersionSnapshot,
  snapshotPluginVersion,
  verifyPackArchive,
  type ImportedAgentProfileRow,
  type PackItemResult,
  type PackRow,
  type PluginRow,
} from '../services/plugins.js';
import { importSkillFromPack } from '../services/skills.js';
import { writeAudit } from '../services/audit.js';
import { getControls } from '../services/controls.js';

export const KERNEL_API_VERSION = '1.0.0';

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/;
const PLUGIN_VERSION = /^\d+\.\d+\.\d+$/;

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

const PluginInstallBody = z
  .object({
    id: z.string().min(1),
    version: z.string().optional(),
    allowDowngrade: z.boolean().default(false),
    /** Approve a widened permission manifest explicitly (ADR-0054 §2). */
    approveGrants: z.boolean().default(false),
  })
  .strict();

/**
 * A signed pack (22.T12) is a signed list of module entries plus optional
 * skills/agent profiles. `packUrl` and `pack` (base64) are mutually exclusive;
 * the signature is always required, and `sha256` pins the exact archive.
 */
const PackInstallBody = z
  .object({
    packUrl: z.string().min(1).max(2000).optional(),
    pack: z.string().min(1).max(20_000_000).optional(),
    signature: z.string().min(1).max(10_000),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'sha256 must be lowercase hex')
      .optional(),
    approveGrants: z.boolean().default(false),
  })
  .strict()
  .refine((value) => Boolean(value.packUrl) !== Boolean(value.pack), {
    message: 'send exactly one of packUrl or pack',
  });

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
  const packStore = new PackStore(kernel.database);

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
      // Packs share the admin list surface so no new RBAC rule is needed.
      packs: await packStore.list(),
      available,
      registry: deps.registryUrl === 'off' ? 'off' : 'configured',
      trustedKeys: deps.trustedKeys.map((key) => key.id),
    };
  });

  interface PackPluginState {
    id: string;
    installedVersion: string | null;
    previous: PluginRow | null;
    previousGrant: ModuleGrantRow | null;
    backup: string | null;
    recorded: boolean;
    grantApproved: boolean;
  }

  const rollbackPackPlugin = async (state: PackPluginState, actor: string | null) => {
    if (state.backup && state.previous) {
      await restorePluginVersionSnapshot(
        state.backup,
        deps.pluginsRoot,
        state.id,
        state.previous.version,
      );
    } else if (state.installedVersion && state.previous?.version !== state.installedVersion) {
      await removePluginVersion(deps.pluginsRoot, state.id, state.installedVersion);
    }
    if (state.recorded && state.previous) {
      await deps.store.restore(state.previous, actor);
    } else if (state.recorded) {
      await deps.store.remove(state.id, actor);
    }
    if (state.grantApproved && state.previousGrant) {
      await kernel.grantStore.restore(state.previousGrant);
    }
  };

  /**
   * 22.T12: install a signed pack as one unit. Each module entry is installed
   * from the registry; a built-in (non-registry) module is reported, never
   * silently enabled (ADR-0007). Skills and agent profiles in the archive are
   * imported as content only. Failures are per item; a failed reload rolls
   * every plugin in the pack back to its previous generation (12.T2).
   */
  const installPack = async (
    body: z.infer<typeof PackInstallBody>,
    actor: string | null,
  ): Promise<{ pack: PackRow; items: PackItemResult[]; ok: boolean }> => {
    let archive: Uint8Array;
    try {
      archive = body.pack
        ? new Uint8Array(Buffer.from(body.pack, 'base64'))
        : await downloadPackArchive(body.packUrl as string, deps.getEgress());
    } catch (err) {
      throw invalid(`could not read the pack archive: ${(err as Error).message}`);
    }
    if (archive.byteLength === 0) throw invalid('pack archive is empty');

    let verified;
    try {
      verified = verifyPackArchive({
        archive,
        signature: body.signature,
        expectedSha256: body.sha256,
        publicKeys: deps.trustedKeys.map((key) => key.publicKey),
      });
    } catch (err) {
      throw invalid(`pack verification failed: ${(err as Error).message}`);
    }
    const manifest: PackManifest = verified.manifest;
    const index =
      deps.registryUrl === 'off'
        ? null
        : await fetchRegistryIndex(deps.registryUrl, deps.getEgress()).catch(() => null);
    const items: PackItemResult[] = [];
    const states: PackPluginState[] = [];
    let installedAny = false;

    for (const entry of manifest.modules) {
      const registryEntry = index ? choosePackRegistryEntry(index, entry.id, entry.version) : null;
      if (!registryEntry) {
        const builtIn = kernel.infos().some((info) => info.id === entry.id);
        items.push({
          id: entry.id,
          kind: 'module',
          status: builtIn ? 'builtin' : entry.optional ? 'skipped' : 'failed',
          version: entry.version,
          reason: builtIn
            ? 'built-in module; enable it in config'
            : entry.optional
              ? 'optional module is not available'
              : 'required module is not in the registry',
        });
        continue;
      }
      const previous = (await deps.store.list()).find((row) => row.id === entry.id) ?? null;
      const previousGrant = await kernel.grantStore.get(entry.id);
      const state: PackPluginState = {
        id: entry.id,
        installedVersion: null,
        previous,
        previousGrant,
        backup: null,
        recorded: false,
        grantApproved: false,
      };
      try {
        if (previous && previous.version === registryEntry.version) {
          state.backup = await snapshotPluginVersion(deps.pluginsRoot, entry.id, previous.version);
        }
        const approved = previousGrant;
        const plugin = await installFromRegistry({
          id: entry.id,
          version: registryEntry.version,
          currentVersion: deps.currentVersions()[entry.id],
          registryUrl: deps.registryUrl,
          pluginsRoot: deps.pluginsRoot,
          trustedKeys: deps.trustedKeys,
          kernelApiVersion: KERNEL_API_VERSION,
          actor,
          egress: deps.getEgress(),
        });
        state.installedVersion = plugin.manifest.version;
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
        state.grantApproved = true;
        await deps.store.record(plugin, actor, deps.trustedKeys[0]?.id ?? null);
        state.recorded = true;
        states.push(state);
        installedAny = true;
        items.push({
          id: entry.id,
          kind: 'plugin',
          status: 'installed',
          version: plugin.manifest.version,
        });
      } catch (err) {
        await rollbackPackPlugin(state, actor);
        items.push({
          id: entry.id,
          kind: 'plugin',
          status: 'failed',
          version: registryEntry.version,
          reason: (err as Error).message.slice(0, 300),
        });
      }
    }

    let imported: ImportResult = {
      pluginId: manifest.id,
      skills: [],
      agents: [],
      notImported: [],
    };
    try {
      imported = importPackContents(verified.files, manifest.id);
    } catch (err) {
      items.push({
        id: 'content',
        kind: 'content',
        status: 'failed',
        reason: (err as Error).message.slice(0, 300),
      });
    }
    const profiles: ImportedAgentProfileRow[] = [];
    for (const skill of imported.skills) {
      try {
        const saved = await importSkillFromPack(kernel, {
          ownerId: null,
          name: skill.name,
          description: skill.description,
          body: skill.body,
          sourceUrl: `pack:${manifest.id}@${manifest.version}`,
          sourceRef: verified.sha256,
          license: manifest.license,
          actor: actor ?? 'system:pack',
        });
        items.push({ id: saved.name, kind: 'skill', status: 'imported' });
      } catch (err) {
        items.push({
          id: skill.name,
          kind: 'skill',
          status: 'failed',
          reason: (err as Error).message.slice(0, 300),
        });
      }
    }
    for (const agent of imported.agents) {
      profiles.push({
        name: agent.name,
        packId: manifest.id,
        body: agent.body,
        importedAt: new Date().toISOString(),
      });
      items.push({ id: agent.name, kind: 'agent', status: 'imported' });
    }
    try {
      await packStore.recordAgentProfiles(profiles, actor);
    } catch (err) {
      for (const profile of profiles) {
        const item = items.find((entry) => entry.kind === 'agent' && entry.id === profile.name);
        if (item) {
          item.status = 'failed';
          item.reason = (err as Error).message.slice(0, 300);
        }
      }
    }
    for (const skipped of imported.notImported) {
      items.push({ id: skipped, kind: 'content', status: 'skipped' });
    }

    try {
      if (installedAny) await deps.reload(`install pack ${manifest.id}@${manifest.version}`);
    } catch (err) {
      for (const state of states.reverse()) await rollbackPackPlugin(state, actor);
      await writeAudit(kernel.database, {
        actor,
        action: 'pack.install_failed',
        subject: manifest.id,
        payload: { version: manifest.version, error: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
    for (const state of states) await discardPluginVersionSnapshot(state.backup);

    const row: PackRow = {
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      license: manifest.license,
      sha256: verified.sha256,
      signature: verified.signature,
      modules: manifest.modules.map((entry) => entry.id),
      skills: imported.skills.map((skill) => skill.name),
      agents: imported.agents.map((agent) => agent.name),
      wiring: manifest.wiring,
      installedBy: actor,
      installedAt: new Date().toISOString(),
    };
    const succeeded = items.some(
      (item) => item.status !== 'failed' && item.status !== 'unavailable',
    );
    if (!succeeded) {
      throw invalid(`pack ${manifest.id}@${manifest.version} installed no items`);
    }
    await packStore.record(row, actor);
    return { pack: row, items, ok: items.every((item) => item.status !== 'failed') };
  };

  // A base64 pack is larger than a plugin install body; keep the default cap
  // for every other route and raise it only here.
  app.post('/api/v1/plugins/install', { bodyLimit: 25 * 1024 * 1024 }, async (request) => {
    const controls = await getControls(kernel.database);
    if (controls.pluginInstallsBlocked) {
      throw policyBlocked('plugin installs are blocked by the kill switch');
    }
    const actor = request.principal?.email ?? null;
    const packBody = PackInstallBody.safeParse(request.body ?? {});
    if (packBody.success) return installPack(packBody.data, actor);
    const body = PluginInstallBody.parse(request.body ?? {});
    // 12.T2: snapshot the current version before touching disk so a failed
    // reload (or a same-version reinstall whose module fails to load) can put
    // the running generation back instead of leaving the new one on disk.
    const previousRow = (await deps.store.list()).find((row) => row.id === body.id) ?? null;
    const previousGrant = previousRow ? await kernel.grantStore.get(body.id) : null;
    const backup =
      previousRow && body.version && previousRow.version === body.version
        ? await snapshotPluginVersion(deps.pluginsRoot, body.id, previousRow.version)
        : null;
    let installedVersion: string | null = null;
    let grantApproved = false;
    let recorded = false;
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
      installedVersion = plugin.manifest.version;
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
      grantApproved = true;
      if (diff.added.length > 0 || diff.removed.length > 0) {
        await writeAudit(kernel.database, {
          actor,
          action: 'module.grants.approved',
          subject: plugin.manifest.id,
          payload: { version: plugin.manifest.version, diff },
        });
      }
      await deps.store.record(plugin, actor, deps.trustedKeys[0]?.id ?? null);
      recorded = true;
      await deps.reload(`install ${plugin.manifest.id}@${plugin.manifest.version}`);
      await discardPluginVersionSnapshot(backup);
      return {
        installed: {
          id: plugin.manifest.id,
          version: plugin.manifest.version,
          sha256: plugin.sha256,
          enabled: false,
        },
      };
    } catch (err) {
      // Roll the disk, the install row and the grant row back to the previous
      // generation before reporting the failure (12.T2).
      if (backup && previousRow) {
        await restorePluginVersionSnapshot(backup, deps.pluginsRoot, body.id, previousRow.version);
      } else if (installedVersion && previousRow?.version !== installedVersion) {
        await removePluginVersion(deps.pluginsRoot, body.id, installedVersion);
      }
      if (recorded && previousRow) {
        await deps.store.restore(previousRow, actor);
      } else if (recorded && !previousRow) {
        await deps.store.remove(body.id, actor);
      }
      if (grantApproved && previousGrant) {
        await kernel.grantStore.restore(previousGrant);
      }
      await writeAudit(kernel.database, {
        actor,
        action: 'plugin.install_failed',
        subject: body.id,
        payload: {
          error: (err as Error).message.slice(0, 500),
          ...(previousRow ? { restoredVersion: previousRow.version } : {}),
        },
      });
      throw err;
    }
  });

  app.post('/api/v1/plugins/:id/enable', async (request) => {
    const { id } = request.params as { id: string };
    const rows = (await deps.store.list()).find((row) => row.id === id);
    if (!rows) throw notFound(`plugin ${id} is not installed`);
    const actor = request.principal?.email ?? null;
    const previousGrant = await kernel.grantStore.get(id);
    await deps.store.setEnabled(id, true, actor);
    try {
      await deps.reload(`enable ${id}`);
    } catch (err) {
      // A plugin that cannot boot must not stay enabled, or every later boot
      // repeats the failure (12.T2). The previous generation keeps serving.
      await deps.store.setEnabled(id, false, actor);
      if (previousGrant) await kernel.grantStore.restore(previousGrant);
      throw err;
    }
    return { id, enabled: true };
  });

  app.post('/api/v1/plugins/:id/disable', async (request) => {
    const { id } = request.params as { id: string };
    const rows = (await deps.store.list()).find((row) => row.id === id);
    if (!rows) throw notFound(`plugin ${id} is not installed`);
    const actor = request.principal?.email ?? null;
    const previousGrant = await kernel.grantStore.get(id);
    await deps.store.setEnabled(id, false, actor);
    try {
      await deps.reload(`disable ${id}`);
    } catch (err) {
      await deps.store.setEnabled(id, true, actor);
      if (previousGrant) await kernel.grantStore.restore(previousGrant);
      throw err;
    }
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

  // Dynamic web bundles (ADR-0027). Immutable per (id, version); both path
  // segments are strict and the resolved file must stay under the version
  // directory (F1: an encoded `%2F` must never escape the plugin volume).
  app.get('/plugins/:id/:version/*', async (request, reply) => {
    const { id, version } = request.params as { id: string; version: string };
    const wildcard = (request.params as Record<string, string>)['*'] ?? '';
    if (!PLUGIN_ID.test(id) || !PLUGIN_VERSION.test(version)) {
      throw invalid('invalid plugin bundle path');
    }
    const root = resolve(deps.pluginsRoot, id, version);
    const target = resolve(root, wildcard);
    const within = relative(root, target);
    if (!within || within.startsWith('..') || isAbsolute(within)) {
      throw invalid('invalid plugin bundle path');
    }
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
