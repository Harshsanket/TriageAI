import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { ulid } from 'ulid';

import { ApprovalStore } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { observeFlowRun } from '../src/services/approvals.js';

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

  it('groups pending calls and decides a subset atomically', async () => {
    const store = new ApprovalStore(app.kernel!.database);
    const runId = `run-batch-${ulid()}`;
    const ids: string[] = [];
    for (const body of ['One', 'Two', 'Three']) {
      const queued = await store.create({
        runId,
        stepId: 'send',
        toolName: 'support.reply',
        input: { body },
        preview: { summary: 'Send a reply', affects: [`ticket-${body}`] },
        expiresAfterMs: 60_000,
      });
      ids.push(queued.id);
    }
    await store.create({
      runId,
      stepId: 'draft',
      toolName: 'email.draft',
      input: {},
      preview: { summary: 'Draft an email', affects: [] },
      expiresAfterMs: 60_000,
    });

    const grouped = await app.inject({ method: 'GET', url: '/api/v1/approvals?grouped=1' });
    expect(grouped.statusCode).toBe(200);
    const batch = (grouped.json() as { batches: Array<Record<string, unknown>> }).batches.find(
      (entry) => entry.runId === runId && entry.toolName === 'support.reply',
    );
    expect(batch).toMatchObject({ count: 3, summary: '3 × Send a reply' });
    expect((batch?.items as Array<{ id: string }>).map((item) => item.id).sort()).toEqual(
      [...ids].sort(),
    );

    const approved = await app.inject({
      method: 'POST',
      url: '/api/v1/approvals/batch',
      payload: { ids: ids.slice(0, 2), outcome: 'approve', reason: 'batch ok' },
    });
    expect(approved.statusCode).toBe(200);
    expect(
      (approved.json() as { approvals: Array<{ status: string; approver: string }> }).approvals,
    ).toEqual([
      expect.objectContaining({ status: 'approved', approver: 'local@triageai.dev' }),
      expect.objectContaining({ status: 'approved', approver: 'local@triageai.dev' }),
    ]);
    expect((await store.get(ids[2] as string))?.status).toBe('pending');

    const noReason = await app.inject({
      method: 'POST',
      url: '/api/v1/approvals/batch',
      payload: { ids: [ids[2]], outcome: 'reject' },
    });
    expect(noReason.statusCode).toBe(400);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/approvals/batch',
      payload: { ids: [ids[2]], outcome: 'reject', reason: 'not right' },
    });
    expect(rejected.statusCode).toBe(200);
    expect((await store.get(ids[2] as string))?.status).toBe('rejected');

    // Re-deciding an item from the same subset conflicts and changes nothing.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/approvals/batch',
      payload: { ids: [ids[0], ids[2]], outcome: 'approve' },
    });
    expect(again.statusCode).toBe(409);
    expect((await store.get(ids[2] as string))?.status).toBe('rejected');
  });

  it('keeps park_as_draft expiry in the approval preview', async () => {
    const store = new ApprovalStore(app.kernel!.database);
    const queued = await store.create({
      runId: `run-draft-${ulid()}`,
      stepId: 'send',
      toolName: 'support.reply',
      input: { body: 'Prepared reply' },
      preview: { summary: 'Send a reply', affects: ['ticket-1'] },
      expiresAfterMs: 1,
      onExpiry: 'park_as_draft',
    });
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    await store.expireDue();
    const applied = await store.applyExpiryTo(queued.id);
    expect(applied.outcome.action).toBe('park_as_draft');
    expect(applied.approval).toMatchObject({
      status: 'expired',
      reason: 'parked_as_draft',
    });
    expect(applied.approval.preview).toMatchObject({
      summary: 'Send a reply',
      draft: {
        approvalId: queued.id,
        toolName: 'support.reply',
        input: { body: 'Prepared reply' },
      },
    });
  });

  it('round-trips the approval policy with a hard floor', async () => {
    const policy = {
      mode: 'auto_allowlist',
      allowlist: [{ tool: 'kb.create_document', conditions: { audience: 'public' }, maxPerRun: 2 }],
      hardFloor: ['*refund*'],
      expiresAfterMs: 3_600_000,
      onExpiry: 'park_as_draft',
    };
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/approval-policy',
      payload: policy,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject(policy);

    const get = await app.inject({ method: 'GET', url: '/api/v1/system/approval-policy' });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject(policy);

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/v1/system/approval-policy',
      payload: { mode: 'auto_allowlist', allowlist: [{ tool: '*' }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('suggests, accepts and automatically demotes per-flow autonomy', async () => {
    const flow = `test.flow.${ulid().toLowerCase()}`;
    for (let run = 0; run < 5; run += 1) {
      await observeFlowRun(app.kernel!.database, {
        flow,
        category: 'billing',
        action: 'reply',
        by: 'test',
      });
    }
    const listed = await app.inject({ method: 'GET', url: '/api/v1/system/autonomy' });
    expect(listed.statusCode).toBe(200);
    const view = (listed.json() as { flows: Array<Record<string, unknown>> }).flows.find(
      (entry) => entry.flow === flow,
    );
    expect(view).toMatchObject({
      level: 'draft',
      cleanRunStreak: 5,
      suggestion: { level: 'internal_note', reason: 'promotion_suggested' },
    });

    const accepted = await app.inject({
      method: 'PUT',
      url: `/api/v1/system/autonomy/${flow}`,
      payload: { category: 'billing', level: 'internal_note' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ level: 'internal_note', cleanRunStreak: 0 });

    const dirty = await observeFlowRun(app.kernel!.database, {
      flow,
      category: 'billing',
      action: 'escalate',
      by: 'test',
    });
    expect(dirty).toMatchObject({ changed: true, reason: 'dirty_run_demotion' });
    expect(dirty.record.level).toBe('draft');
    const audited = await app.kernel!.database.query(
      `SELECT 1 FROM audit_events WHERE action = 'autonomy.changed' AND subject = $1`,
      [`${flow}::billing`],
    );
    expect(audited).toHaveLength(1);

    const acceptedAutopilot = await app.inject({
      method: 'PUT',
      url: `/api/v1/system/autonomy/${flow}`,
      payload: { category: 'billing', level: 'autopilot' },
    });
    expect(acceptedAutopilot.statusCode).toBe(200);
    const production = await observeFlowRun(app.kernel!.database, {
      flow,
      category: 'billing',
      action: 'reply',
      targetProduction: true,
      by: 'test',
    });
    expect(production).toMatchObject({ changed: true, reason: 'production_target' });
    expect(production.record.level).toBe('draft');
  });
});
