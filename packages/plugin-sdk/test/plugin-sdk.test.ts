import { describe, expect, it } from 'vitest';

import {
  assertRoutesDeclared,
  generatePluginKeyPair,
  packPlugin,
  packFiles,
  PluginManifestSchema,
  readPluginPackage,
  RegistryEntrySchema,
  sha256,
  signPluginPackage,
  unpackFiles,
  verifyBytes,
  verifyBytes as verify,
} from '../src/index.js';

const manifest = {
  id: 'demo-plugin',
  version: '1.2.3',
  kernelApi: '^1.0.0',
  capabilities: [],
  routes: [{ method: 'GET' as const, path: '/api/v1/demo/hello', roles: ['admin' as const] }],
  license: 'MIT',
};

describe('plugin package format (phase 12)', () => {
  it('round-trips files through the USTAR writer/reader', () => {
    const archive = packFiles([
      { path: 'a.txt', content: 'hello' },
      { path: 'nested/b.txt', content: Buffer.from('world') },
    ]);
    const files = unpackFiles(archive);
    expect(files.get('a.txt')?.toString()).toBe('hello');
    expect(files.get('nested/b.txt')?.toString()).toBe('world');
  });

  it('packs a plugin with manifest, server and web bundles', () => {
    const bytes = packPlugin({
      manifest,
      server: 'export const module = { id: "demo-plugin" };',
      web: 'export default function Demo() { return null; }',
      migrations: { '0001-demo.sql': 'CREATE TABLE demo (id text);' },
    });
    const read = readPluginPackage(bytes);
    expect(read.manifest.id).toBe('demo-plugin');
    expect(read.serverCode).toContain('export const module');
    expect(read.webCode).toContain('export default');
    expect(read.files.get('migrations/0001-demo.sql')?.toString()).toContain('CREATE TABLE');
  });

  it('rejects path traversal', () => {
    const archive = packFiles([{ path: 'ok.txt', content: 'x' }]);
    const files = unpackFiles(archive);
    expect(files.has('../evil.txt')).toBe(false);
    expect(() => unpackFiles(Buffer.from('not a tgz'))).toThrow();
  });

  it('signs with ed25519 and refuses tampering or an unknown key', () => {
    const keys = generatePluginKeyPair();
    const other = generatePluginKeyPair();
    const bytes = packPlugin({ manifest, server: 'export const module = {};' });
    const signature = signPluginPackage(bytes, keys.privateKey);

    expect(verifyBytes(bytes, signature, keys.publicKey)).toBe(true);
    expect(verify(bytes, signature, other.publicKey)).toBe(false);

    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(verifyBytes(tampered, signature, keys.publicKey)).toBe(false);
    expect(sha256(tampered)).not.toBe(sha256(bytes));
  });

  it('refuses a route the manifest did not declare', () => {
    expect(() =>
      assertRoutesDeclared(
        {
          ...manifest,
          server: 'server/index.js',
          routes: [],
          capabilities: [],
        },
        [{ method: 'GET', url: '/api/v1/demo/hello' }],
      ),
    ).toThrow(/undeclared route/);
  });

  it('validates registry entries', () => {
    expect(() =>
      RegistryEntrySchema.parse({
        id: 'demo',
        version: '1.0.0',
        kernelApi: '^1.0.0',
        sha256: 'nope',
        signature: 'sig',
        url: 'https://plugins.example/demo.tgz',
      }),
    ).toThrow();
  });
});

describe('plugin version hardening (phase 21)', () => {
  it('rejects path traversal and non-semver versions', () => {
    for (const version of ['1.0.0-/../../x', '../1.0.0', '1.0', '1.0.0/evil', '1..0']) {
      expect(
        PluginManifestSchema.safeParse({
          id: 'demo',
          version,
          kernelApi: '^1.0.0',
          license: 'MIT',
        }).success,
      ).toBe(false);
    }
    expect(
      PluginManifestSchema.safeParse({
        id: 'demo',
        version: '1.2.3-beta.1',
        kernelApi: '^1.0.0',
        license: 'MIT',
      }).success,
    ).toBe(true);
  });
});
