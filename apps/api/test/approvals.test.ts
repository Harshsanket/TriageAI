import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import { ApprovalStore } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

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

describeIfDb('approvals inbox (phase 15)', () => {
  it('queues, approves and rejects a tool call once', async () => {
    const store = new ApprovalStore(app.kernel!.database);
    const queued = await store.create({
      runId: 'run-1',
      stepId: 'step-1',
      toolName: 'support.reply',
      input: { body: 'Hello' },
      preview: { summary: 'Send a reply', affects: ['ticket-1'] },
      expiresAfterMs: 60_000,
    });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/approvals' });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as Array<{ id: string }>).some((row) => row.id === queued.id)).toBe(true);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${queued.id}/approve`,
      payload: { reason: 'looks right' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved', approver: 'local@triageai.dev' });

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${queued.id}/reject`,
      payload: { reason: 'late' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('requires a rejection reason and expires due approvals', async () => {
    const store = new ApprovalStore(app.kernel!.database);
    const queued = await store.create({
      runId: 'run-2',
      stepId: 'step-2',
      toolName: 'crm.create_deal',
      input: {},
      expiresAfterMs: 1,
    });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/approvals/${queued.id}/reject`,
      payload: {},
    });
    expect(rejected.statusCode).toBe(400);

    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    const expired = await store.expireDue();
    expect(expired.some((row) => row.id === queued.id)).toBe(true);
  });
});
