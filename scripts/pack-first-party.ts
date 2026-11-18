/**
 * Pack a first-party module as a signed plugin archive (Phase 12.T4).
 *
 *   pnpm pack:first-party --id echo --out dist/packs
 *
 * The server bundle is self-contained ESM (kernel/contracts are bundled in) so
 * it can be installed from the plugin volume. First-party modules still load
 * in-host by default; this produces an installable artifact for operators who
 * prefer the package path. Signing uses TRIAGEAI_PLUGIN_PRIVATE_KEY when set;
 * otherwise an ephemeral key is generated and its public key is written next
 * to the archive (trust it explicitly before installing).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'esbuild';

import {
  generatePluginKeyPair,
  packPlugin,
  signPluginPackage,
} from '../packages/plugin-sdk/src/index.js';
import { MODULES } from '../apps/api/src/modules.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const id = arg('id');
  const outDir = resolve(arg('out') ?? 'dist/packs');
  if (!id) {
    console.error('usage: pnpm pack:first-party --id <module> [--out dir]');
    process.exitCode = 1;
    return;
  }
  const module = MODULES[id];
  if (!module) {
    console.error(`unknown first-party module "${id}"`);
    process.exitCode = 1;
    return;
  }
  const root = resolve(process.cwd(), '../..');
  const source = resolve(root, 'modules', id, 'src/index.ts');
  const temp = await mkdtemp(join(tmpdir(), `triageai-pack-${id}-`));
  try {
    const entry = join(temp, 'entry.ts');
    await writeFile(
      entry,
      `import * as mods from ${JSON.stringify(source)};
const found = Object.values(mods).find(
  (value) => value && typeof value === 'object' && (value as { id?: string }).id === ${JSON.stringify(id)},
);
export const module = found;
`,
      'utf8',
    );
    const serverDir = join(temp, 'server');
    await mkdir(serverDir, { recursive: true });
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: join(serverDir, 'index.js'),
      logLevel: 'silent',
    });
    const server = await readFile(join(serverDir, 'index.js'), 'utf8');
    const manifest = {
      id,
      version: module.version,
      kernelApi: '^1.0.0',
      capabilities: module.capabilities ?? [],
      routes: module.permissions?.routes ?? [],
      license: 'MIT',
    };
    const archive = packPlugin({ manifest, server });
    const privateKey = process.env.TRIAGEAI_PLUGIN_PRIVATE_KEY;
    let signature: string;
    let publicKey: string | undefined;
    if (privateKey) {
      signature = signPluginPackage(archive, privateKey);
    } else {
      const keys = generatePluginKeyPair();
      signature = signPluginPackage(archive, keys.privateKey);
      publicKey = keys.publicKey;
      console.warn('TRIAGEAI_PLUGIN_PRIVATE_KEY is not set; generated an ephemeral signing key.');
    }
    await mkdir(outDir, { recursive: true });
    const archivePath = join(outDir, `${id}-${module.version}.tgz`);
    await writeFile(archivePath, archive);
    await writeFile(`${archivePath}.sig`, signature, 'utf8');
    if (publicKey) await writeFile(`${archivePath}.pub`, publicKey, 'utf8');
    console.log(`packed ${id}@${module.version} -> ${archivePath} (${archive.byteLength} bytes)`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

void main();
