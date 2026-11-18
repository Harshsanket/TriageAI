import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Approval, ApprovalExpiry } from '../src/approvals.js';
import { ApprovalPolicySchema } from '../src/approvals/policy.js';
import type { ApprovalPolicy } from '../src/approvals/policy.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { executeToolSequence, invokeWithApproval } from '../src/tools/pipeline.js';
import type { ApprovalQueue } from '../src/tools/pipeline.js';
import type { ToolContext, ToolDefinition } from '../src/tools/types.js';

const ctx: ToolContext = {
  runId: 'run-1',
  stepId: 'step-1',
  grantedScopes: ['kb:write', 'email:send'],
  egressClass: 'internal',
  org: { ownsEmail: () => true },
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
};

class FakeApprovals implements ApprovalQueue {
  readonly rows: Approval[] = [];

  async create(args: {
    runId: string;
    stepId: string;
    toolName: string;
    input: unknown;
    preview?: unknown;
    expiresAfterMs: number;
    onExpiry?: ApprovalExpiry;
  }): Promise<Approval> {
    const approval: Approval = {
      id: `approval-${this.rows.length + 1}`,
      runId: args.runId,
      stepId: args.stepId,
      toolName: args.toolName,
      input: args.input,
      preview: args.preview ?? null,
      status: 'pending',
      onExpiry: args.onExpiry ?? 'escalate',
      approver: null,
      reason: null,
      expiresAt: new Date(Date.now() + args.expiresAfterMs).toISOString(),
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    this.rows.push(approval);
    return approval;
  }

  async attachReceipt(id: string, receipt: unknown): Promise<Approval> {
    const row = this.rows.find((approval) => approval.id === id) as Approval;
    row.preview = { ...(row.preview as object), receipt };
    return row;
  }
}

const base = {
  name: 'kb.create_document',
  version: '1.0.0',
  owner: 'test',
  description: 'Create a document in the knowledge base for the requested topic.',
  examples: [{ title: 'Refunds' }],
  input: z.object({ title: z.string().min(1) }).strict(),
  output: z.object({ id: z.string() }).strict(),
  access: 'write' as const,
  risk: 'low' as const,
  scopes: ['kb:write'],
  egressClass: 'internal' as const,
  idempotent: true,
  timeoutMs: 1_000,
  undo: 'compensable' as const,
  retry: { maxAttempts: 0, backoff: 'none' as const, retryOn: [] },
  compensate: async () => undefined,
  preview: async (input: { title: string }) => ({
    summary: `Create ${input.title}`,
    affects: ['kb'],
  }),
  handler: async (input: { title: string }) => ({ id: `doc-${input.title}` }),
} satisfies ToolDefinition<{ title: string }, { id: string }>;

function registryWith(...tools: unknown[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool as ToolDefinition<unknown, unknown>);
  return registry;
}

function policy(overrides: Record<string, unknown>): ApprovalPolicy {
  return ApprovalPolicySchema.parse({ mode: 'auto_allowlist', allowlist: [], ...overrides });
}

describe('high-risk tool pipeline (phase 15.T2)', () => {
  it('auto-invokes an allowlisted write with approved:true', async () => {
    const registry = registryWith(base);
    const approvals = new FakeApprovals();
    const outcome = await invokeWithApproval(registry, {
      tool: 'kb.create_document',
      input: { title: 'Refunds' },
      ctx,
      approvals,
      policy: policy({ allowlist: [{ tool: 'kb.create_document' }] }),
    });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.result).toEqual({ ok: true, data: { id: 'doc-Refunds' } });
    expect(outcome.decision).toEqual({ action: 'auto', reason: 'allowlisted' });
    expect(outcome.receipt.completed).toEqual([{ tool: 'kb.create_document', count: 1 }]);
    expect(outcome.receipt.sent).toEqual([]);
    expect(approvals.rows).toHaveLength(0);
  });

  it('queues a preview and expiry when the policy asks', async () => {
    const registry = registryWith(base);
    const approvals = new FakeApprovals();
    const outcome = await invokeWithApproval(registry, {
      tool: 'kb.create_document',
      input: { title: 'Refunds' },
      ctx,
      approvals,
      policy: policy({ mode: 'ask' }),
    });
    expect(outcome.status).toBe('awaiting');
    if (outcome.status !== 'awaiting') return;
    expect(outcome.decision).toEqual({ action: 'ask', reason: 'mode_ask' });
    expect(outcome.approval).toMatchObject({
      runId: 'run-1',
      stepId: 'step-1',
      toolName: 'kb.create_document',
      onExpiry: 'escalate',
    });
    expect(outcome.approval.preview).toMatchObject({ summary: 'Create Refunds' });
    expect(outcome.receipt.waiting[0]).toMatchObject({
      tool: 'kb.create_document',
      count: 1,
      parked: true,
    });
  });

  it('queues hard-floor calls even when allowlisted (never auto)', async () => {
    const deleteTool = {
      ...base,
      name: 'crm.delete_deal',
      access: 'write' as const,
      risk: 'high' as const,
      undo: 'none' as const,
      scopes: ['kb:write'],
      compensate: undefined,
    } as unknown as ToolDefinition<unknown, unknown>;
    const registry = registryWith(deleteTool);
    const approvals = new FakeApprovals();
    const outcome = await invokeWithApproval(registry, {
      tool: 'crm.delete_deal',
      input: { title: 'Refunds' },
      ctx,
      approvals,
      policy: policy({ allowlist: [{ tool: 'crm.delete_deal' }] }),
    });
    expect(outcome.status).toBe('awaiting');
    if (outcome.status !== 'awaiting') return;
    expect(outcome.decision).toEqual({ action: 'deny', reason: 'hard_floor:protected_action' });
    expect(approvals.rows).toHaveLength(1);
  });

  it('blocks without queueing when preview fails', async () => {
    const broken = {
      ...base,
      name: 'kb.create_document',
      preview: async () => {
        throw new Error('preview exploded');
      },
    } satisfies ToolDefinition<{ title: string }, { id: string }>;
    const registry = registryWith(broken);
    const approvals = new FakeApprovals();
    const outcome = await invokeWithApproval(registry, {
      tool: 'kb.create_document',
      input: { title: 'Refunds' },
      ctx,
      approvals,
      policy: policy({ allowlist: [{ tool: 'kb.create_document' }] }),
    });
    expect(outcome.status).toBe('blocked');
    if (outcome.status !== 'blocked') return;
    expect(outcome.error.code).toBe('tool.PREVIEW_FAILED');
    expect(approvals.rows).toHaveLength(0);
  });

  it('verifies an executed call and records it in the receipt', async () => {
    const getStatus = vi.fn(async () => 'applied' as const);
    const send = {
      ...base,
      name: 'email.send',
      description: 'Send a prepared email to the requester after validation.',
      scopes: ['email:send'],
      risk: 'high' as const,
      undo: 'none' as const,
      compensate: undefined,
      getStatus,
    } as unknown as ToolDefinition<unknown, unknown>;
    const registry = registryWith(send);
    const approvals = new FakeApprovals();
    const outcome = await invokeWithApproval(registry, {
      tool: 'email.send',
      input: { title: 'Refunds' },
      ctx,
      approvals,
      policy: policy({ allowlist: [{ tool: 'email.send' }] }),
    });
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.verification).toEqual({
      status: 'applied',
      idempotencyKey: 'run-1:step-1:email.send',
    });
    expect(getStatus).toHaveBeenCalledWith('run-1:step-1:email.send', ctx);
    expect(outcome.receipt.sent).toEqual([{ tool: 'email.send', count: 1 }]);
  });
});

describe('reversible execution + irreversible park (phase 15.T8)', () => {
  it('finishes reversible calls, parks at the first undo:none call and keeps the receipt', async () => {
    const send = {
      ...base,
      name: 'email.send',
      description: 'Send a prepared email to the requester after validation.',
      scopes: ['email:send'],
      risk: 'high' as const,
      undo: 'none' as const,
      compensate: undefined,
    } as unknown as ToolDefinition<unknown, unknown>;
    const registry = registryWith(base, send);
    const approvals = new FakeApprovals();
    const outcome = await executeToolSequence(registry, {
      ctx,
      approvals,
      policy: policy({
        allowlist: [{ tool: 'kb.create_document' }, { tool: 'email.send' }],
      }),
      calls: [
        { tool: 'kb.create_document', input: { title: 'Refunds' } },
        { tool: 'email.send', input: { title: 'Refunds' } },
        { tool: 'kb.create_document', input: { title: 'Later' } },
      ],
    });
    expect(outcome.stoppedAt).toBe(1);
    expect(outcome.executed.map((call) => call.tool)).toEqual(['kb.create_document']);
    expect(outcome.parked).toHaveLength(1);
    expect(outcome.parked[0]?.toolName).toBe('email.send');
    expect(outcome.receipt.completed).toEqual([{ tool: 'kb.create_document', count: 1 }]);
    expect(outcome.receipt.waiting[0]).toMatchObject({ tool: 'email.send', parked: true });
    expect(outcome.receipt.sent).toEqual([]);
    // The parked approval carries the deterministic receipt in its preview.
    expect(outcome.parked[0]?.preview).toMatchObject({
      receipt: { runId: 'run-1', useful: true },
    });
    // The call after the park never ran.
    expect(approvals.rows).toHaveLength(1);
  });
});
