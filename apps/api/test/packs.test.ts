import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  generatePluginKeyPair,
  packPack,
  packPlugin,
  sha256,
  signPack,
  signPluginPackage,
} from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

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
  manifest: { routes: [], nav: [], background: [] },
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
  root = await mkdtemp(path.join(tmpdir(), 'triageai-packs-'));
});

afterEach(async () => {
  const kernel = (app as (FastifyInstance & { kernel?: Kernel }) | undefined)?.kernel;
  if (kernel) {
    await kernel.database
      .query(`DELETE FROM user_skills WHERE source_url LIKE 'pack:%'`)
      .catch(() => undefined);
    await kernel.database
      .query(`DELETE FROM settings WHERE key = ANY($1::text[])`, [
        ['plugins.packs', 'plugins.agentProfiles'],
      ])
      .catch(() => undefined);
    await kernel.database
      .query(`DELETE FROM plugin_installs WHERE id = 'demo-plugin'`)
      .catch(() => undefined);
  }
  await app?.close();
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

async function buildPackApp(): Promise<{
  app: FastifyInstance;
  keys: ReturnType<typeof generatePluginKeyPair>;
  packArchive: Buffer;
  packSignature: string;
}> {
  const keys = generatePluginKeyPair();
  const pluginArchive = packPlugin({ manifest: MANIFEST, server: SERVER });
  const pluginPath = path.join(root, 'demo-plugin-1.0.0.tgz');
  await writeFile(pluginPath, pluginArchive);
  const indexPath = path.join(root, 'index.json');
  await writeFile(
    indexPath,
    JSON.stringify({
      version: 1,
      plugins: [
        {
          id: 'demo-plugin',
          version: '1.0.0',
          kernelApi: '^1.0.0',
          sha256: sha256(pluginArchive),
          signature: signPluginPackage(pluginArchive, keys.privateKey),
          url: pathToFileURL(pluginPath).href,
        },
      ],
    }),
  );

  const packArchive = packPack({
    manifest: {
      id: 'demo-pack',
      version: '1.0.0',
      name: 'Demo pack',
      license: 'MIT',
      modules: [{ id: 'demo-plugin', version: '1.0.0' }],
      wiring: { 'capabilities.chatModel.provider': 'demo-plugin' },
    },
    extraFiles: [
      {
        path: 'skills/handoff/SKILL.md',
        content:
          '---\nname: handoff\ndescription: Write a concise structured handoff for another agent.\n---\n\nDo the thing.',
      },
      {
        path: 'agents/reviewer.md',
        content: '---\nname: reviewer\n---\n\nReview carefully.',
      },
      { path: 'commands/run.md', content: 'not imported' },
    ],
  });

  const built = await buildApp({
    quiet: true,
    configPath: path.resolve(process.cwd(), '../../triage.config.json'),
    pluginsRoot: path.join(root, 'installed'),
    pluginKeys: [{ id: 'test', publicKey: keys.publicKey }],
    pluginRegistryUrl: pathToFileURL(indexPath).href,
  });
  return {
    app: built,
    keys,
    packArchive,
    packSignature: signPack(packArchive, keys.privateKey),
  };
}

describeIfDb('signed pack install (22.T12)', () => {
  it('verifies, installs module entries and imports skills and agent profiles', async () => {
    const built = await buildPackApp();
    app = built.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { pack: built.packArchive.toString('base64'), signature: built.packSignature },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      pack: { id: string; modules: string[]; skills: string[]; agents: string[]; wiring: unknown };
      items: Array<{ id: string; kind: string; status: string }>;
      ok: boolean;
    };
    expect(body.ok, JSON.stringify(body.items)).toBe(true);
    expect(body.pack).toMatchObject({
      id: 'demo-pack',
      modules: ['demo-plugin'],
      skills: ['handoff'],
      agents: ['reviewer'],
      wiring: { 'capabilities.chatModel.provider': 'demo-plugin' },
    });
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'demo-plugin', kind: 'plugin', status: 'installed' }),
        expect.objectContaining({ id: 'handoff', kind: 'skill', status: 'imported' }),
        expect.objectContaining({ id: 'reviewer', kind: 'agent', status: 'imported' }),
        expect.objectContaining({
          id: 'commands (harness-specific)',
          kind: 'content',
          status: 'skipped',
        }),
      ]),
    );

    const listed = await app.inject({ method: 'GET', url: '/api/v1/plugins' });
    expect((listed.json() as { packs: Array<{ id: string; version: string }> }).packs).toEqual([
      expect.objectContaining({ id: 'demo-pack', version: '1.0.0' }),
    ]);

    const kernel = (app as FastifyInstance & { kernel?: Kernel }).kernel;
    const skills = await kernel?.database.query<{ name: string; source_ref: string }>(
      `SELECT name, source_ref FROM user_skills WHERE source_url LIKE 'pack:%'`,
    );
    expect(skills?.map((skill) => skill.name)).toEqual(['handoff']);
    expect(skills?.[0]?.source_ref).toBe(sha256(built.packArchive));
    const profiles = await kernel?.database.query<{ value: { profiles?: unknown[] } }>(
      `SELECT value FROM settings WHERE key = 'plugins.agentProfiles'`,
    );
    expect(profiles?.[0]?.value.profiles).toHaveLength(1);
  });

  it('refuses a tampered pack signature and records nothing', async () => {
    const built = await buildPackApp();
    app = built.app;
    const tampered = Buffer.from(built.packArchive);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: { pack: tampered.toString('base64'), signature: built.packSignature },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('pack verification failed');
    const listed = await app.inject({ method: 'GET', url: '/api/v1/plugins' });
    expect((listed.json() as { packs: unknown[] }).packs).toEqual([]);
  });

  it('accepts a pack URL and refuses a pack with no installable items', async () => {
    const built = await buildPackApp();
    app = built.app;
    const packPath = path.join(root, 'demo-pack.tgz');
    await writeFile(packPath, built.packArchive);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: {
        packUrl: pathToFileURL(packPath).href,
        signature: built.packSignature,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Array<{ id: string; status: string }> };
    expect(body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'demo-plugin', status: 'installed' })]),
    );

    const missing = packPack({
      manifest: {
        id: 'missing-pack',
        version: '1.0.0',
        name: 'Missing pack',
        license: 'MIT',
        modules: [{ id: 'not-a-real-module', version: '^1.0.0' }],
      },
    });
    const missingRes = await app.inject({
      method: 'POST',
      url: '/api/v1/plugins/install',
      payload: {
        pack: missing.toString('base64'),
        signature: signPack(missing, built.keys.privateKey),
      },
    });
    expect(missingRes.statusCode).toBe(400);
    expect(missingRes.body).toContain('installed no items');
  });
});
