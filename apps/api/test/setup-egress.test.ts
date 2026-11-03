import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

type App = Awaited<ReturnType<typeof buildApp>> & { kernel?: Kernel };

describeIfDb('setup probes use the egress guard (phase 37 F6)', () => {
  let app: App;
  let dir: string;
  let server: Server;
  let localBase = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/api/pull') {
        response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
        response.end();
        return;
      }
      if (request.url === '/api/version') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"version":"0.0.0"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    localBase = `http://localhost:${port}`;

    dir = await mkdtemp(path.join(tmpdir(), 'triageai-setup-egress-'));
    const configPath = path.join(dir, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'inline' },
        modules: {},
        capabilities: {},
        egress: { allowlist: [{ host: 'api.github.com', dataClass: 'public' }] },
      }),
    );
    app = (await buildApp({
      quiet: true,
      configPath,
      setup: false,
      authMode: 'disabled',
    })) as App;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('never probes metadata or private hosts and audits the refusal', async () => {
    const hardware = await app.inject({
      method: 'GET',
      url: '/api/v1/setup/hardware?ollamaUrl=http%3A%2F%2F169.254.169.254',
    });
    expect(hardware.statusCode).toBe(200);
    expect((hardware.json() as { services: { ollama: boolean } }).services.ollama).toBe(false);
    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE subject = 'setup-hardware' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe('egress.denied');

    const llm = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/llm/test',
      payload: { runtime: 'ollama', baseUrl: 'http://10.0.0.5:11434', model: 'test' },
    });
    expect(llm.statusCode).toBe(200);
    expect((llm.json() as { ok: boolean }).ok).toBe(false);

    const pull = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/models/pull',
      payload: { baseUrl: 'http://10.0.0.5:11434', model: 'test' },
    });
    expect(pull.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('blocks a redirect from an allowlisted local runtime to metadata', async () => {
    const pull = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/models/pull',
      payload: { baseUrl: localBase, model: 'test' },
    });
    expect(pull.statusCode).toBeGreaterThanOrEqual(400);
  });
});
