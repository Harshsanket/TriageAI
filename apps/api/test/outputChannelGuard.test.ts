import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createOutputChannelRegistry } from '@triageai/kernel';
import type { DeliveryContext, Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

const ctx: DeliveryContext = {
  runId: 'run-1',
  workflowId: 'wf-1',
  stageId: 'stage-1',
  orgId: null,
};

describeIfDb('OutputChannel kill switch (18.T6)', () => {
  let app: FastifyInstance & { kernel?: Kernel };
  const registry = createOutputChannelRegistry();

  beforeAll(async () => {
    app = await buildApp({
      quiet: true,
      setup: false,
      authMode: 'disabled',
      capabilities: { outputChannel: registry },
    });
    // Other suites share this database; start from a known control state.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: false },
    });
    registry.register('fixture', {
      deliver: async () => ({ ref: 'fixture-ref', channel: 'fixture' }),
    });
  });

  afterEach(async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: false },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('readOnly blocks deliveries through the host registry and audits the denial', async () => {
    await expect(
      registry.deliver(ctx, { channel: 'fixture', body: 'hello' }),
    ).resolves.toMatchObject({ ref: 'fixture-ref' });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: true },
    });
    expect(updated.statusCode).toBe(200);

    await expect(
      registry.deliver(ctx, { channel: 'fixture', body: 'hello' }),
    ).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
      category: 'policy_blocked',
    });

    const audit = await app.kernel!.database.query<{ action: string; subject: string | null }>(
      `SELECT action, subject FROM audit_events WHERE action = 'output.denied' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit[0]).toMatchObject({ action: 'output.denied', subject: 'fixture' });
  });
});
