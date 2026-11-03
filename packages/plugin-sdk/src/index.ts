/**
 * Plugin SDK (Phase 12): the signed `.tgz` package format, ed25519 signing and
 * a dependency-free USTAR reader/writer so installs work offline.
 *
 * Layout:
 *   plugin.json          PluginManifest
 *   server/index.js      ESM module exporting `module` (a ModuleDefinition)
 *   web/index.js         optional ESM component bundle (React external)
 *   migrations/*.sql     optional SQL applied through the kernel runner
 */
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { z } from 'zod';

import { ModulePermissionsSchema } from '@triageai/contracts';

export const PluginRouteSchema = z.object({
  method: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE)$/),
  path: z.string().startsWith('/api/'),
  roles: z.array(z.enum(['customer', 'agent', 'admin'])).default([]),
});
export type PluginRoute = z.infer<typeof PluginRouteSchema>;

export const PluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'plugin id is lowercase kebab-case'),
    version: z
      .string()
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
        'version must be strict semver (no path characters)',
      )
      .refine((value) => !value.split(/[.+-]/).includes('..'), 'invalid version'),
    kernelApi: z.string().min(1),
    capabilities: z.array(z.string()).default([]),
    routes: z.array(PluginRouteSchema).default([]),
    /** ADR-0054 §2: enforced by the kernel; widest grants need approval. */
    permissions: ModulePermissionsSchema.optional(),
    ramMb: z.number().int().positive().optional(),
    diskMb: z.number().int().positive().optional(),
    license: z.string().min(1),
    server: z.string().default('server/index.js'),
    web: z.string().optional(),
    description: z.string().max(400).optional(),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PackModuleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.string().min(1),
    optional: z.boolean().default(false),
  })
  .strict();

export const PackManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    version: z.string().min(1),
    name: z.string().min(1).max(200),
    license: z.string().min(1),
    modules: z.array(PackModuleSchema).min(1),
    /** Config wiring applied on approval (capabilities.<id>.provider, modules.*.enabled). */
    wiring: z.record(z.string(), z.unknown()).prefault({}),
    description: z.string().max(400).optional(),
  })
  .strict();
export type PackManifest = z.infer<typeof PackManifestSchema>;

export interface PackPackage {
  manifest: PackManifest;
  files: Map<string, Buffer>;
  sha256: string;
  signature: string;
}

export function packPack(input: {
  manifest: z.input<typeof PackManifestSchema>;
  extraFiles?: PluginFile[];
}): Buffer {
  const manifest = PackManifestSchema.parse(input.manifest);
  const files: PluginFile[] = [
    { path: 'pack.json', content: JSON.stringify(manifest, null, 2) },
    ...(input.extraFiles ?? []),
  ];
  return packFiles(files);
}

export function readPackPackage(archive: Uint8Array): PackPackage {
  const files = unpackFiles(archive);
  const manifestBytes = files.get('pack.json');
  if (!manifestBytes) throw new Error('pack has no pack.json');
  return {
    manifest: PackManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8'))),
    files,
    sha256: sha256(archive),
    signature: '',
  };
}

/** Verify a signed pack archive; a tampered byte changes the sha256 and signature. */
export function verifyPackPackage(options: {
  archive: Uint8Array;
  signature: string;
  publicKeys: string[];
}): PackPackage {
  const pack = readPackPackage(options.archive);
  const valid = options.publicKeys.some((key) =>
    verifyBytes(options.archive, options.signature, key),
  );
  if (!valid) throw new Error('pack signature is invalid');
  return { ...pack, signature: options.signature };
}

export function signPack(archive: Uint8Array, privateKey: string): string {
  return signPluginPackage(archive, privateKey);
}

export const RegistryEntrySchema = z.object({
  id: z.string(),
  version: z.string(),
  kernelApi: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(1),
  url: z.string().url(),
  keyId: z.string().optional(),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

export const RegistryIndexSchema = z.object({
  version: z.literal(1).default(1),
  generatedAt: z.string().optional(),
  plugins: z.array(RegistryEntrySchema),
});
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;

/** Identity helper for plugin authors; type-checked by the SDK. */
export function definePlugin<T>(definition: T): T {
  return definition;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── ed25519 ──────────────────────────────────────────────────────────────────

export function generatePluginKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function signBytes(bytes: Uint8Array, privateKey: string): string {
  return sign(null, bytes, {
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  }).toString('base64');
}

export function verifyBytes(bytes: Uint8Array, signature: string, publicKey: string): boolean {
  try {
    return verify(
      null,
      bytes,
      { key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' },
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Sign the archive bytes (the registry stores this signature next to the sha256). */
export function signPluginPackage(bytes: Uint8Array, privateKey: string): string {
  return signBytes(bytes, privateKey);
}

// ── USTAR (deterministic, no tiny dependencies) ──────────────────────────────

export interface PluginFile {
  path: string;
  content: Uint8Array | string;
}

function header(path: string, size: number): Buffer {
  if (Buffer.byteLength(path) > 100) throw new Error(`plugin path too long: ${path}`);
  const block = Buffer.alloc(512, 0);
  block.write(path, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

function pad512(bytes: Buffer): Buffer {
  const remainder = bytes.length % 512;
  if (remainder === 0) return bytes;
  return Buffer.concat([bytes, Buffer.alloc(512 - remainder, 0)]);
}

export function packFiles(files: PluginFile[]): Buffer {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const parts: Buffer[] = [];
  for (const file of sorted) {
    const content =
      typeof file.content === 'string'
        ? Buffer.from(file.content, 'utf8')
        : Buffer.from(file.content);
    parts.push(header(file.path, content.length), pad512(content));
  }
  parts.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(parts));
}

export function unpackFiles(archive: Uint8Array): Map<string, Buffer> {
  const tar = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name || name.includes('..') || name.startsWith('/')) {
      throw new Error(`unsafe plugin path: ${name}`);
    }
    const size = Number.parseInt(
      block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0',
      8,
    );
    if (!Number.isFinite(size) || size < 0) throw new Error(`invalid plugin entry size: ${name}`);
    const declared = block.subarray(148, 156).toString('ascii');
    const copy = Buffer.from(block);
    copy.write('        ', 148, 8, 'ascii');
    let sum = 0;
    for (const byte of copy) sum += byte;
    if (Number.parseInt(declared.trim(), 8) !== sum) {
      throw new Error(`corrupt plugin archive entry: ${name}`);
    }
    const start = offset + 512;
    if (start + size > tar.length) throw new Error(`truncated plugin archive: ${name}`);
    files.set(name, tar.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

export interface PackPluginInput {
  manifest: z.input<typeof PluginManifestSchema>;
  server: string;
  web?: string;
  migrations?: Record<string, string>;
  extraFiles?: PluginFile[];
}

export function packPlugin(input: PackPluginInput): Buffer {
  const manifest = PluginManifestSchema.parse(input.manifest);
  if (input.web && !manifest.web) manifest.web = 'web/index.js';
  const files: PluginFile[] = [
    { path: 'plugin.json', content: JSON.stringify(manifest, null, 2) },
    { path: manifest.server, content: input.server },
  ];
  if (input.web) files.push({ path: manifest.web ?? 'web/index.js', content: input.web });
  for (const [path, sql] of Object.entries(input.migrations ?? {})) {
    files.push({ path: `migrations/${path}`, content: sql });
  }
  files.push(...(input.extraFiles ?? []));
  return packFiles(files);
}

export interface ReadPluginPackage {
  manifest: PluginManifest;
  files: Map<string, Buffer>;
  serverCode: string;
  webCode?: string;
}

export function readPluginPackage(archive: Uint8Array): ReadPluginPackage {
  const files = unpackFiles(archive);
  const manifestBytes = files.get('plugin.json');
  if (!manifestBytes) throw new Error('plugin package has no plugin.json');
  const manifest = PluginManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const server = files.get(manifest.server);
  if (!server) throw new Error(`plugin package has no ${manifest.server}`);
  const webEntry = manifest.web;
  return {
    manifest,
    files,
    serverCode: server.toString('utf8'),
    webCode: webEntry ? files.get(webEntry)?.toString('utf8') : undefined,
  };
}

/** A plugin must not declare a route it did not list in its manifest. */
export function assertRoutesDeclared(
  manifest: PluginManifest,
  routes: Array<{ method: string; url: string }>,
): void {
  for (const route of routes) {
    const declared = manifest.routes.some(
      (candidate) =>
        candidate.method === route.method.toUpperCase() && candidate.path === route.url,
    );
    if (!declared) {
      throw new Error(
        `plugin ${manifest.id} registered undeclared route ${route.method} ${route.url}`,
      );
    }
  }
}
export * from './importer.js';

export { ModuleClient, createModuleClient } from './moduleClient.js';
export type { Mp1Transport, ModuleClientOptions } from './moduleClient.js';
