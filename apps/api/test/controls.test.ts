import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import { ToolRegistry } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { EgressClient } from '../src/services/egress.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

let app: App;
beforeEach(async () => {
  app = (await buildApp({
    quiet: true,
    configPath: resolve(process.cwd(), '../../triage.config.json'),
  })) as App;
});
afterEach(async () => {
  await app.close();
});

describeIfDb('kill switches and egress (phase 18)', () => {
  it('updates controls, audits them and flips read-only on the live registry', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: true, hostedModelsDisabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ readOnly: true, hostedModelsDisabled: true });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/system/controls' });
    expect(listed.json()).toMatchObject({ readOnly: true });

    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'controls.updated'`,
    );
    expect(audit.length).toBeGreaterThan(0);

    const registry = new ToolRegistry();
    registry.setReadOnly(true);
    registry.register({
      name: 'kb.create_note',
      version: '1.0.0',
      owner: 'kb',
      description: 'Create a note in the knowledge base for later review.',
      examples: [{}],
      input: (await import('zod')).z.object({}).strict(),
      output: (await import('zod')).z.object({ ok: (await import('zod')).z.boolean() }).strict(),
      access: 'write',
      risk: 'low',
      scopes: ['kb:write'],
      egressClass: 'internal',
      idempotent: true,
      timeoutMs: 1000,
      undo: 'free',
      retry: { maxAttempts: 0, backoff: 'none', retryOn: [] },
      handler: async () => ({ ok: true as const }),
    });
    const blocked = await registry.invoke(
      'kb.create_note',
      {},
      {
        runId: 'r',
        stepId: 's',
        grantedScopes: [],
        egressClass: 'internal',
        org: { ownsEmail: () => true },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
    );
    expect(blocked).toMatchObject({ ok: false, error: { code: 'tool.READ_ONLY' } });
  });

  it('blocks an egress host outside the allowlist and audits the denial', async () => {
    const client = new EgressClient(app.kernel!.database, [
      { host: 'huggingface.co', dataClass: 'public' },
    ]);
    expect(client.allows('https://huggingface.co/api/models')).toBe(true);
    await expect(
      client.fetch('https://evil.example/x', {}, { purpose: 'test' }),
    ).rejects.toMatchObject({ category: 'policy_blocked' });
    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'egress.denied'`,
    );
    expect(audit.length).toBeGreaterThan(0);
  });
});
