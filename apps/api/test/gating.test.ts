import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';

/**
 * Phase 1 acceptance criteria (DEVELOPMENT_PLAN §Phase 1):
 *   - manifest-gating: enabling chat in config adds its route/nav/UI entry;
 *     disabling leaves zero chat orphans.
 * - kernel boot validates config; module routes appear through the host.
 */

async function postJson(app: FastifyInstance, url: string, body: Record<string, unknown> = {}) {
  const res = await app.inject({ method: 'POST', url, payload: body });
  return { status: res.statusCode, body: res.json() as unknown };
}

describe('api host + kernel', () => {
  let app: FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };

  beforeEach(async () => {
    app = (await buildApp({ quiet: true })) as FastifyInstance & {
      kernel?: import('@triageai/kernel').Kernel;
    };
  });

  afterEach(async () => {
    await app.close();
  });

  it('exposes the system manifest with the enabled modules only (echo on, chat off)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
    expect(res.statusCode).toBe(200);
    const manifest = res.json() as {
      generatedAt: string;
      modules: Array<{ id: string; version: string; manifest: { nav: { path: string }[] } }>;
    };
    expect(manifest.modules.map((m) => m.id)).toEqual(['echo']);
    expect(manifest.modules[0]?.manifest.nav[0]?.path).toBe('/echo');
    expect(manifest.modules.some((m) => m.id === 'chat')).toBe(false);
  });

  it('echo module route starts a workflow that completes through the pg queue', async () => {
    // route registered from module via kernel (host only mounts it)
    const res = await app.inject({ method: 'GET', url: '/api/v1/echo/runs' });
    if (res.statusCode !== 200) console.error('runs route failed', res.statusCode, res.body);
    expect(res.statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/api/v1/echo/run', payload: { text: 'ship it' } });

    const completed = await pollFor(async () => {
      const r = await app.inject({ method: 'GET', url: '/api/v1/echo/runs' });
      const runs = r.json() as Array<{ id: string; status: string }>;
      return { done: runs.length > 0 && runs.some((x) => x.status === 'SUCCEEDED') };
    });
    expect(completed).toBe(true);
  }, 20000);

  it('kernel module info lists capabilities', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/modules' });
    expect(res.statusCode).toBe(200);
    const modules = res.json() as Array<{ id: string; capabilities: string[] }>;
    const echo = modules.find((m) => m.id === 'echo');
    expect(echo?.capabilities).toContain('queue');
  });

  it('rejects uninstalling an enabled module with a typed conflict', async () => {
    const { status, body } = await postJson(app, '/api/v1/system/modules/echo/uninstall', {});
    expect(status).toBe(409);
    expect((body as { title: string }).title).toBe('kernel.CONFLICT');
  });
});

async function pollFor(fn: () => Promise<{ done: boolean }>, timeoutMs = 15000): Promise<boolean> {
  const started = Date.now();
  for (;;) {
    const state = await fn();
    if (state.done) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
