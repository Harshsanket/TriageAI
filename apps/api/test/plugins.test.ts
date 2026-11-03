import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { generatePluginKeyPair, packPlugin, sha256, signPluginPackage } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

const SERVER = `
export const module = {
  id: 'demo-plugin',
  version: '1.0.0',
  capabilities: [],
  permissions: {
    routes: [{ method: 'GET', path: '/api/v1/demo/hello' }],
    events: { publish: [], subscribe: [] },
    capabilities: { consume: [], provide: [] },
    stages: [],
    workflows: [],
    evals: [],
    tools: [],
    knowledge: { read: [], write: [] }
  },
  dependsOn: { capabilities: [] },
  manifest: {
    routes: [{ path: '/demo', title: 'Demo' }],
    nav: [{ label: 'Demo', order: 500, path: '/demo' }],
    background: []
  },
  lifecycle: { health: async () => ({ status: 'healthy' }) },
  register(ctx) {
    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/demo/hello',
      handler: async () => ({ hello: 'world' })
    });
  }
};
`;

const MANIFEST = {
  id: 'demo-plugin',
  version: '1.0.0',
  kernelApi: '^1.0.0',
  capabilities: [],
  routes: [{ method: 'GET' as const, path: '/api/v1/demo/hello', roles: ['admin' as const] }],
  license: 'MIT',
};

let root: string;
let app: FastifyInstance | undefined;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'triageai-plugins-'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

describeIfDb('hot plugins (phase 12)', () => {
  it('installs, enables and disables a signed plugin without restarting', async () => {
    const keys = generatePluginKeyPair();
    const archive = packPlugin({ manifest: MANIFEST, server: SERVER, web: 'export default null;' });
    const archivePath = path.join(root, 'demo-plugin-1.0.0.tgz');
    await writeFile(archivePath, archive);
    const index = {
      version: 1,
      plugins: [
        {
          id: 'demo-plugin',
          version: '1.0.0',
          kernelApi: '^1.0.0',
          sha256: sha256(archive),
          signature: signPluginPackage(archive, keys.privateKey),
          url: pathToFileURL(archivePath).href,
        },
      ],
    };
    const indexPath = path.join(root, 'index.json');
    await writeFile(indexPath, JSON.stringify(index));

    app = await buildApp({
      quiet: true,
      configPath: path.resolve(process.cwd(), '../../triage.config.json'),
      pluginsRoot: path.join(root, 'installed'),
      pluginKeys: [{ id: 'test', publicKey: keys.publicKey }],
      pluginRegistryUrl: pathToFileURL(indexPath).href,
    });

    const missing = await app.inject({ method: 'GET', url: '/api/v1/demo/hello' });
    expect(missing.statusCode).toBe(404);

    const installed = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { id: 'demo-plugin', version: '1.0.0' },
    });
    expect(installed.statusCode).toBe(200);
    expect(installed.json()).toMatchObject({ installed: { id: 'demo-plugin', enabled: false } });

    const disabledRoute = await app.inject({ method: 'GET', url: '/api/v1/demo/hello' });
    expect(disabledRoute.statusCode).toBe(404);

    const enabled = await app.inject({ method: 'POST', url: '/api/v1/plugins/demo-plugin/enable' });
    expect(enabled.statusCode).toBe(200);
    const live = await app.inject({ method: 'GET', url: '/api/v1/demo/hello' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ hello: 'world' });

    const manifest = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
    expect(
      (manifest.json() as { modules: Array<{ id: string; bundleUrl?: string }> }).modules.find(
        (module) => module.id === 'demo-plugin',
      )?.bundleUrl,
    ).toContain('/plugins/demo-plugin/1.0.0/');

    const web = await app.inject({
      method: 'GET',
      url: '/plugins/demo-plugin/1.0.0/web/index.js',
    });
    expect(web.statusCode).toBe(200);
    expect(web.body).toContain('export default');

    const disabled = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/demo-plugin/disable',
    });
    expect(disabled.statusCode).toBe(200);
    const gone = await app.inject({ method: 'GET', url: '/api/v1/demo/hello' });
    expect(gone.statusCode).toBe(404);
    const manifestAfter = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
    expect(
      (manifestAfter.json() as { modules: Array<{ id: string }> }).modules.some(
        (module) => module.id === 'demo-plugin',
      ),
    ).toBe(false);
  });

  it('refuses encoded path traversal in the public bundle route', async () => {
    app = await buildApp({
      quiet: true,
      configPath: path.resolve(process.cwd(), '../../triage.config.json'),
      pluginsRoot: path.join(root, 'installed'),
    });

    const attempts = [
      '/plugins/demo-plugin/1.0.0%2F..%2F..%2F..%2F..%2Fetc/passwd',
      '/plugins/demo-plugin/1.0.0/../../../../etc/passwd',
      '/plugins/demo-plugin/1.0.0/..%2F..%2F..%2Fetc%2Fpasswd',
      '/plugins/..%2F..%2Fetc/1.0.0/passwd',
      '/plugins/demo-plugin/not-a-version/web/index.js',
    ];
    for (const url of attempts) {
      const res = await app.inject({ method: 'GET', url });
      expect([400, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('root:');
    }
  });

  it('does not import a disabled plugin at boot and imports it on enable (F7)', async () => {
    const sentinel = path.join(root, 'sentinel-imported.txt');
    const server = `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(sentinel)}, 'imported');
export const module = {
  id: 'sentinel-plugin',
  version: '1.0.0',
  capabilities: [],
  permissions: {
    routes: [], events: { publish: [], subscribe: [] },
    capabilities: { consume: [], provide: [] }, stages: [], workflows: [],
    evals: [], tools: [], knowledge: { read: [], write: [] }
  },
  dependsOn: { capabilities: [] },
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: { health: async () => ({ status: 'healthy' }) },
  register() {}
};
`;
    const manifest = { ...MANIFEST, id: 'sentinel-plugin' };
    const keys = generatePluginKeyPair();
    const archive = packPlugin({ manifest, server });
    const archivePath = path.join(root, 'sentinel-plugin-1.0.0.tgz');
    await writeFile(archivePath, archive);
    const indexPath = path.join(root, 'sentinel-index.json');
    await writeFile(
      indexPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: 'sentinel-plugin',
            version: '1.0.0',
            kernelApi: '^1.0.0',
            sha256: sha256(archive),
            signature: signPluginPackage(archive, keys.privateKey),
            url: pathToFileURL(archivePath).href,
          },
        ],
      }),
    );
    const boot = () =>
      buildApp({
        quiet: true,
        configPath: path.resolve(process.cwd(), '../../triage.config.json'),
        pluginsRoot: path.join(root, 'installed'),
        pluginKeys: [{ id: 'test', publicKey: keys.publicKey }],
        pluginRegistryUrl: pathToFileURL(indexPath).href,
      }) as Promise<FastifyInstance>;

    app = await boot();
    const installed = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { id: 'sentinel-plugin', version: '1.0.0' },
    });
    expect(installed.statusCode).toBe(200);
    await access(sentinel);
    await rm(sentinel, { force: true });
    await app.close();

    app = await boot();
    await expect(access(sentinel)).rejects.toThrow();

    const enabled = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/sentinel-plugin/enable',
    });
    expect(enabled.statusCode).toBe(200);
    await access(sentinel);
  });

  it('refuses a tampered archive and an unknown signing key', async () => {
    const keys = generatePluginKeyPair();
    const archive = packPlugin({ manifest: MANIFEST, server: SERVER });
    const tampered = Buffer.from(archive);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const archivePath = path.join(root, 'demo-plugin-1.0.0.tgz');
    await writeFile(archivePath, tampered);
    const index = {
      version: 1,
      plugins: [
        {
          id: 'demo-plugin',
          version: '1.0.0',
          kernelApi: '^1.0.0',
          sha256: sha256(archive),
          signature: signPluginPackage(archive, keys.privateKey),
          url: pathToFileURL(archivePath).href,
        },
      ],
    };
    const indexPath = path.join(root, 'index.json');
    await writeFile(indexPath, JSON.stringify(index));

    app = await buildApp({
      quiet: true,
      configPath: path.resolve(process.cwd(), '../../triage.config.json'),
      pluginsRoot: path.join(root, 'installed'),
      pluginKeys: [{ id: 'test', publicKey: keys.publicKey }],
      pluginRegistryUrl: pathToFileURL(indexPath).href,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { id: 'demo-plugin' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'plugin.SHA256_MISMATCH' });
  });
});
