/**
 * Plugin registry + install store (Phase 12, ADR-0026). The registry is a
 * static signed index; the app never executes anything before verification.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  RegistryIndexSchema,
  installPluginPackage,
  type RegistryEntry,
  type RegistryIndex,
  type TrustedPluginKey,
  type InstalledPlugin,
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

export async function downloadPluginArchive(
  entry: RegistryEntry,
  egress?: EgressClient,
): Promise<Uint8Array> {
  if (entry.url.startsWith('file://')) {
    return new Uint8Array(await readFile(fileURLToPath(entry.url)));
  }
  const parsed = new URL(entry.url);
  if (
    parsed.protocol !== 'https:' &&
    !(process.env.NODE_ENV === 'test' && parsed.protocol === 'http:')
  ) {
    throw new Error('plugin downloads must use HTTPS');
  }
  if (!egress) throw new Error('an egress client is required for plugin downloads');
  const response = await egress.fetch(
    entry.url,
    { signal: AbortSignal.timeout(30_000) },
    { purpose: 'plugin.download', maxBytes: 50_000_000 },
  );
  if (!response.ok) throw new Error(`plugin download answered ${response.status}`);
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
