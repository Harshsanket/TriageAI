/**
 * Plugin registry + install store (Phase 12, ADR-0026). The registry is a
 * static signed index; the app never executes anything before verification.
 */
import { access, readFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RegistryIndexSchema,
  installPluginPackage,
  satisfiesRange,
  verifyPackPackage,
  type InstalledPlugin,
  type PackPackage,
  type RegistryEntry,
  type RegistryIndex,
  type TrustedPluginKey,
} from '@triageai/kernel';
import type { Database } from '@triageai/kernel';

import type { EgressClient } from './egress.js';
import { writeAudit } from './audit.js';

export interface PluginRow {
  id: string;
  version: string;
  sha256: string;
  enabled: boolean;
  keyId: string | null;
  installedBy: string | null;
  installedAt: string;
}

export class PluginStore {
  constructor(private readonly database: Database) {}

  async list(): Promise<PluginRow[]> {
    const rows = (await this.database
      .query(
        `SELECT id, version, sha256, enabled, key_id, installed_by, installed_at
         FROM plugin_installs ORDER BY id`,
      )
      .catch(() => [])) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      version: row.version as string,
      sha256: row.sha256 as string,
      enabled: Boolean(row.enabled),
      keyId: (row.key_id as string | null) ?? null,
      installedBy: (row.installed_by as string | null) ?? null,
      installedAt: new Date(row.installed_at as string).toISOString(),
    }));
  }

  async enabledMap(): Promise<Map<string, boolean>> {
    return new Map((await this.list()).map((row) => [row.id, row.enabled]));
  }

  async record(plugin: InstalledPlugin, actor: string | null, keyId: string | null): Promise<void> {
    await this.database.query(
      `INSERT INTO plugin_installs (id, version, sha256, enabled, key_id, installed_by, installed_at)
       VALUES ($1, $2, $3, false, $4, $5, now())
       ON CONFLICT (id) DO UPDATE
         SET version = EXCLUDED.version, sha256 = EXCLUDED.sha256,
             enabled = false, key_id = EXCLUDED.key_id,
             installed_by = EXCLUDED.installed_by, installed_at = now()`,
      [plugin.manifest.id, plugin.manifest.version, plugin.sha256, keyId, actor],
    );
    await writeAudit(this.database, {
      actor,
      action: 'plugin.installed',
      subject: plugin.manifest.id,
      payload: { version: plugin.manifest.version, sha256: plugin.sha256 },
    });
  }

  async setEnabled(id: string, enabled: boolean, actor: string | null): Promise<void> {
    await this.database.query(`UPDATE plugin_installs SET enabled = $2 WHERE id = $1`, [
      id,
      enabled,
    ]);
    await writeAudit(this.database, {
      actor,
      action: enabled ? 'plugin.enabled' : 'plugin.disabled',
      subject: id,
    });
  }

  async remove(id: string, actor: string | null): Promise<void> {
    await this.database.query(`DELETE FROM plugin_installs WHERE id = $1`, [id]);
    await writeAudit(this.database, { actor, action: 'plugin.uninstalled', subject: id });
  }

  /**
   * Put a previous install row back after a failed soft-reload (12.T2). This
   * preserves the original enabled state/installed_at instead of recording a
   * fresh install, so the next boot serves the version that was running.
   */
  async restore(row: PluginRow, actor: string | null): Promise<void> {
    await this.database.query(
      `INSERT INTO plugin_installs
         (id, version, sha256, enabled, key_id, installed_by, installed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
         SET version = EXCLUDED.version, sha256 = EXCLUDED.sha256,
             enabled = EXCLUDED.enabled, key_id = EXCLUDED.key_id,
             installed_by = EXCLUDED.installed_by, installed_at = EXCLUDED.installed_at`,
      [row.id, row.version, row.sha256, row.enabled, row.keyId, row.installedBy, row.installedAt],
    );
    await writeAudit(this.database, {
      actor,
      action: 'plugin.rollback',
      subject: row.id,
      payload: { version: row.version },
    });
  }
}

/** One installed signed pack (22.T12). Stored in `settings.plugins.packs`. */
export interface PackRow {
  id: string;
  version: string;
  name: string;
  license: string;
  sha256: string;
  signature: string;
  modules: string[];
  skills: string[];
  agents: string[];
  wiring: Record<string, unknown>;
  installedBy: string | null;
  installedAt: string;
}

export interface ImportedAgentProfileRow {
  name: string;
  packId: string;
  body: string;
  importedAt: string;
}

export interface PackItemResult {
  id: string;
  kind: 'plugin' | 'module' | 'skill' | 'agent' | 'content';
  status: 'installed' | 'builtin' | 'imported' | 'skipped' | 'unavailable' | 'failed';
  version?: string;
  reason?: string;
}

const PACKS_KEY = 'plugins.packs';
const AGENT_PROFILES_KEY = 'plugins.agentProfiles';

/**
 * Packs have no table of their own: they are an install record, not a runtime
 * module, so a versioned settings row keeps uninstall/migration surface at zero.
 */
export class PackStore {
  constructor(private readonly database: Database) {}

  async list(): Promise<PackRow[]> {
    const rows = await this.database
      .query<{ value: { packs?: PackRow[] } }>(`SELECT value FROM settings WHERE key = $1`, [
        PACKS_KEY,
      ])
      .catch(() => []);
    const packs = rows[0]?.value?.packs;
    return Array.isArray(packs) ? packs : [];
  }

  async record(pack: PackRow, actor: string | null): Promise<void> {
    const packs = (await this.list()).filter((entry) => entry.id !== pack.id);
    packs.push(pack);
    await this.database.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [PACKS_KEY, { packs }, actor ?? 'system'],
    );
    await writeAudit(this.database, {
      actor,
      action: 'pack.installed',
      subject: pack.id,
      payload: { version: pack.version, sha256: pack.sha256, modules: pack.modules },
    });
  }

  async recordAgentProfiles(
    profiles: ImportedAgentProfileRow[],
    actor: string | null,
  ): Promise<void> {
    if (profiles.length === 0) return;
    const rows = await this.database
      .query<{ value: { profiles?: ImportedAgentProfileRow[] } }>(
        `SELECT value FROM settings WHERE key = $1`,
        [AGENT_PROFILES_KEY],
      )
      .catch(() => []);
    const existing = Array.isArray(rows[0]?.value?.profiles) ? rows[0].value.profiles : [];
    const merged = [
      ...existing.filter((entry) => !profiles.some((next) => next.name === entry.name)),
      ...profiles,
    ];
    await this.database.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [AGENT_PROFILES_KEY, { profiles: merged }, actor ?? 'system'],
    );
    await writeAudit(this.database, {
      actor,
      action: 'pack.agent_profiles_imported',
      subject: profiles[0]?.packId ?? 'pack',
      payload: { profiles: profiles.map((entry) => entry.name) },
    });
  }
}

/** Verify a signed pack archive, optionally pinning its sha256. */
export function verifyPackArchive(options: {
  archive: Uint8Array;
  signature: string;
  expectedSha256?: string;
  publicKeys: string[];
}): PackPackage {
  const pack = verifyPackPackage({
    archive: options.archive,
    signature: options.signature,
    publicKeys: options.publicKeys,
  });
  if (options.expectedSha256 && pack.sha256 !== options.expectedSha256) {
    throw new Error(
      `pack sha256 mismatch (expected ${options.expectedSha256}, got ${pack.sha256})`,
    );
  }
  return pack;
}

/** Pick the newest registry entry matching a pack's semver range. */
export function choosePackRegistryEntry(
  index: RegistryIndex,
  id: string,
  range: string,
): RegistryEntry | undefined {
  return index.plugins
    .filter((entry) => entry.id === id && satisfiesRange(entry.version, range).ok)
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
    .at(-1);
}

/**
 * Move an installed version directory aside before a same-version reinstall
 * (12.T2). Returns the backup path, or null when nothing was installed.
 */
export async function snapshotPluginVersion(
  pluginsRoot: string,
  id: string,
  version: string,
): Promise<string | null> {
  const directory = resolve(pluginsRoot, id, version);
  try {
    await access(directory);
  } catch {
    return null;
  }
  const backup = `${directory}.previous-${Date.now()}`;
  await rename(directory, backup);
  return backup;
}

/** Drop a snapshot after the new generation booted successfully. */
export async function discardPluginVersionSnapshot(backup: string | null): Promise<void> {
  if (backup) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

/** Restore a same-version snapshot after a failed soft-reload. */
export async function restorePluginVersionSnapshot(
  backup: string,
  pluginsRoot: string,
  id: string,
  version: string,
): Promise<void> {
  const directory = resolve(pluginsRoot, id, version);
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  await rename(backup, directory);
}

/** Remove a version directory that never reached a successful boot. */
export async function removePluginVersion(
  pluginsRoot: string,
  id: string,
  version: string,
): Promise<void> {
  await rm(resolve(pluginsRoot, id, version), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

let cachedIndex: { url: string; at: number; index: RegistryIndex } | null = null;
const INDEX_TTL_MS = 60_000;

/** Fetch the static registry index. `off` disables downloads entirely. */
export async function fetchRegistryIndex(
  url: string,
  egress?: EgressClient,
): Promise<RegistryIndex> {
  if (!url || url === 'off') return RegistryIndexSchema.parse({ plugins: [] });
  if (cachedIndex && cachedIndex.url === url && Date.now() - cachedIndex.at < INDEX_TTL_MS) {
    return cachedIndex.index;
  }
  let raw: string;
  if (url.startsWith('file://')) {
    raw = await readFile(fileURLToPath(url), 'utf8');
  } else {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' &&
      !(process.env.NODE_ENV === 'test' && parsed.protocol === 'http:')
    ) {
      throw new Error('plugin registry must be an HTTPS URL (or file:// in tests)');
    }
    if (!egress) throw new Error('an egress client is required for plugin registry downloads');
    const response = await egress.fetch(
      url,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
      { purpose: 'plugin.registry' },
    );
    if (!response.ok) throw new Error(`plugin registry answered ${response.status}`);
    raw = await response.text();
  }
  const index = RegistryIndexSchema.parse(JSON.parse(raw));
  cachedIndex = { url, at: Date.now(), index };
  return index;
}

export function chooseRegistryEntry(
  index: RegistryIndex,
  id: string,
  version?: string,
): RegistryEntry | undefined {
  const candidates = index.plugins.filter((entry) => entry.id === id);
  if (version) return candidates.find((entry) => entry.version === version);
  return candidates
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
    .at(-1);
}

async function downloadArchive(
  url: string,
  egress: EgressClient | undefined,
  purpose: string,
): Promise<Uint8Array> {
  if (url.startsWith('file://')) {
    return new Uint8Array(await readFile(fileURLToPath(url)));
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !(process.env.NODE_ENV === 'test' && parsed.protocol === 'http:')
  ) {
    throw new Error('archive downloads must use HTTPS');
  }
  if (!egress) throw new Error('an egress client is required for archive downloads');
  const response = await egress.fetch(
    url,
    { signal: AbortSignal.timeout(30_000) },
    { purpose, maxBytes: 50_000_000 },
  );
  if (!response.ok) throw new Error(`archive download answered ${response.status}`);
  const maxBytes = 50_000_000;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('plugin download exceeds the 50 MB cap');
    }
    chunks.push(value);
  }
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

export async function downloadPluginArchive(
  entry: RegistryEntry,
  egress?: EgressClient,
): Promise<Uint8Array> {
  return downloadArchive(entry.url, egress, 'plugin.download');
}

/** Fetch a signed pack from a URL (or `file://` in tests). */
export async function downloadPackArchive(url: string, egress?: EgressClient): Promise<Uint8Array> {
  return downloadArchive(url, egress, 'pack.download');
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface InstallFromRegistryOptions {
  id: string;
  version?: string;
  currentVersion?: string;
  allowDowngrade?: boolean;
  registryUrl: string;
  pluginsRoot: string;
  trustedKeys: TrustedPluginKey[];
  kernelApiVersion: string;
  actor: string | null;
  egress?: EgressClient;
}

export async function installFromRegistry(
  options: InstallFromRegistryOptions,
): Promise<InstalledPlugin> {
  const index = await fetchRegistryIndex(options.registryUrl, options.egress);
  const entry = chooseRegistryEntry(index, options.id, options.version);
  if (!entry) throw new Error(`plugin ${options.id} is not in the registry`);
  if (
    !options.allowDowngrade &&
    options.currentVersion &&
    compareVersions(entry.version, options.currentVersion) < 0
  ) {
    throw new Error(
      `refusing to downgrade ${options.id} from ${options.currentVersion} to ${entry.version}`,
    );
  }
  const archive = await downloadPluginArchive(entry, options.egress);
  const plugin = await installPluginPackage({
    archive,
    pluginsRoot: options.pluginsRoot,
    trustedKeys: options.trustedKeys,
    kernelApiVersion: options.kernelApiVersion,
    expectedSha256: entry.sha256,
    signature: entry.signature,
  });
  return plugin;
}
