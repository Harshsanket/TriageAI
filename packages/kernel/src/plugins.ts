/**
 * Plugin installation and loading (Phase 12, ADR-0026).
 *
 * The registry is only a transport: a package is refused unless its sha256 and
 * ed25519 signature match a pinned key, its `kernelApi` range accepts this
 * kernel, and every route it registers was declared in `plugin.json`.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PluginManifestSchema,
  assertRoutesDeclared,
  readPluginPackage,
  sha256,
  verifyBytes,
  type PluginManifest,
} from '@triageai/plugin-sdk';

import { AppError } from './errors.js';
import { satisfiesRange } from './semver.js';
import type { TriageModule } from './types.js';

export interface TrustedPluginKey {
  id: string;
  publicKey: string;
}

export interface VerifyPluginOptions {
  archive: Uint8Array;
  trustedKeys: TrustedPluginKey[];
  kernelApiVersion: string;
  /** Registry-provided values; the archive is refused when they do not match. */
  expectedSha256?: string;
  signature?: string;
}

export interface VerifiedPlugin {
  manifest: PluginManifest;
  sha256: string;
}

export class PluginError extends AppError {
  constructor(code: string, message: string, status = 400) {
    super(code, message, undefined, status, { category: 'validation', retryable: false });
  }
}

/** Verify an archive before a single byte touches the volume. */
export function verifyPluginPackage(options: VerifyPluginOptions): VerifiedPlugin {
  const digest = sha256(options.archive);
  if (options.expectedSha256 && options.expectedSha256 !== digest) {
    throw new PluginError(
      'plugin.SHA256_MISMATCH',
      `plugin archive sha256 ${digest} does not match the registry value`,
    );
  }
  if (options.signature) {
    const trusted = options.trustedKeys.some((key) =>
      verifyBytes(options.archive, options.signature as string, key.publicKey),
    );
    if (!trusted) {
      throw new PluginError(
        'plugin.SIGNATURE_INVALID',
        'plugin archive is unsigned or signed by an unknown key',
      );
    }
  } else {
    throw new PluginError('plugin.SIGNATURE_REQUIRED', 'plugin archive has no signature');
  }

  let manifest: PluginManifest;
  try {
    manifest = readPluginPackage(options.archive).manifest;
  } catch (err) {
    throw new PluginError(
      'plugin.PACKAGE_INVALID',
      `plugin archive could not be read: ${(err as Error).message}`,
    );
  }
  if (!satisfiesRange(options.kernelApiVersion, manifest.kernelApi)) {
    throw new PluginError(
      'plugin.KERNEL_API_MISMATCH',
      `plugin ${manifest.id} requires kernel ${manifest.kernelApi}; this is ${options.kernelApiVersion}`,
    );
  }
  return { manifest, sha256: digest };
}

export interface InstallPluginOptions extends VerifyPluginOptions {
  /** Root of the `triageai-plugins` volume. */
  pluginsRoot: string;
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  directory: string;
  sha256: string;
  module: TriageModule;
}

/**
 * Verify, unpack atomically and import the server module. A failed import or a
 * manifest/module mismatch removes the whole version directory again, so the
 * previous plugin set keeps serving (ADR-0026).
 */
export async function installPluginPackage(
  options: InstallPluginOptions,
): Promise<InstalledPlugin> {
  const verified = verifyPluginPackage(options);
  const { manifest } = verified;
  const finalDir = resolve(options.pluginsRoot, manifest.id, manifest.version);
  if (!finalDir.startsWith(`${resolve(options.pluginsRoot)}/`)) {
    throw new PluginError(
      'plugin.PATH_TRAVERSAL',
      `plugin ${manifest.id}@${manifest.version} escapes the plugins root`,
    );
  }
  const stagingDir = `${finalDir}.staging-${process.pid}-${Date.now()}`;

  await mkdir(dirname(stagingDir), { recursive: true });
  try {
    const read = readPluginPackage(options.archive);
    for (const [path, content] of read.files) {
      const target = resolve(stagingDir, path);
      if (!target.startsWith(`${resolve(stagingDir)}/`)) {
        throw new PluginError('plugin.PATH_TRAVERSAL', `unsafe plugin path ${path}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { mode: 0o644 });
    }
    await writeFile(
      resolve(stagingDir, 'package.json'),
      JSON.stringify({ name: `triageai-plugin-${manifest.id}`, type: 'module', private: true }),
      'utf8',
    );
    await rm(finalDir, { recursive: true, force: true });
    await mkdir(dirname(finalDir), { recursive: true });
    await rename(stagingDir, finalDir);
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof AppError) throw err;
    throw new PluginError(
      'plugin.INSTALL_FAILED',
      `plugin ${manifest.id} could not be unpacked: ${(err as Error).message}`,
    );
  }

  try {
    const module = await loadPluginModule(finalDir, manifest);
    return { manifest, directory: finalDir, sha256: verified.sha256, module };
  } catch (err) {
    await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
    if (err instanceof AppError) throw err;
    throw new PluginError(
      'plugin.LOAD_FAILED',
      `plugin ${manifest.id} failed to load: ${(err as Error).message}`,
    );
  }
}

export async function loadPluginModule(
  directory: string,
  manifest: PluginManifest,
): Promise<TriageModule> {
  const serverPath = resolve(directory, manifest.server);
  const imported = (await import(`${pathToFileURL(serverPath).href}?v=${Date.now()}`)) as {
    module?: TriageModule;
  };
  const module = imported.module;
  if (!module) throw new Error('server bundle must export `module`');
  if (module.id !== manifest.id) {
    throw new Error(`server module id ${module.id} does not match plugin id ${manifest.id}`);
  }
  if (module.version !== manifest.version) {
    throw new Error(
      `server module version ${module.version} does not match plugin version ${manifest.version}`,
    );
  }
  module.bundleUrl = manifest.web
    ? `/plugins/${manifest.id}/${manifest.version}/${manifest.web}`
    : undefined;
  // ADR-0054: anything loaded from a signed archive is third-party code and
  // must pass the default-deny grant engine (and, later, a container).
  module.thirdParty = true;
  return module;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  directory: string;
  module: TriageModule;
}

/** Load every unpacked plugin version under the volume (latest version wins). */
export async function loadInstalledPlugins(
  pluginsRoot: string,
  kernelApiVersion: string,
): Promise<LoadedPlugin[]> {
  let ids: string[];
  try {
    ids = await readdir(pluginsRoot);
  } catch {
    return [];
  }
  const plugins: LoadedPlugin[] = [];
  for (const id of ids) {
    if (id.startsWith('.')) continue;
    let versions: string[];
    try {
      versions = (await readdir(join(pluginsRoot, id))).filter((entry) =>
        /^\d+\.\d+\.\d+/.test(entry),
      );
    } catch {
      continue;
    }
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const version = versions.at(-1);
    if (!version) continue;
    const directory = join(pluginsRoot, id, version);
    try {
      const manifest = PluginManifestSchema.parse(
        JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8')),
      );
      if (!satisfiesRange(kernelApiVersion, manifest.kernelApi)) continue;
      const module = await loadPluginModule(directory, manifest);
      plugins.push({ manifest, directory, module });
    } catch {
      // A corrupt installed version must not stop the host from booting.
    }
  }
  return plugins;
}

export async function uninstallPluginVersion(
  pluginsRoot: string,
  id: string,
  version?: string,
): Promise<void> {
  const idDir = resolve(pluginsRoot, id);
  if (version) {
    await rm(join(idDir, version), { recursive: true, force: true });
  } else {
    await rm(idDir, { recursive: true, force: true });
  }
}

export async function installedPluginVersions(
  pluginsRoot: string,
): Promise<Array<{ id: string; version: string; directory: string }>> {
  try {
    const ids = await readdir(pluginsRoot);
    const rows: Array<{ id: string; version: string; directory: string }> = [];
    for (const id of ids) {
      const idDir = join(pluginsRoot, id);
      if (!(await stat(idDir).catch(() => null))?.isDirectory()) continue;
      for (const version of await readdir(idDir).catch(() => [] as string[])) {
        if (/^\d+\.\d+\.\d+/.test(version)) {
          rows.push({ id, version, directory: join(idDir, version) });
        }
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** Throw if the module registers anything its signed manifest did not declare. */
export function assertPluginRoutes(manifest: PluginManifest, routes: string[]): void {
  const parsed = routes.map((route) => {
    const [method, url] = route.split(' ');
    return { method: method ?? '', url: url ?? '' };
  });
  assertRoutesDeclared(manifest, parsed);
}
