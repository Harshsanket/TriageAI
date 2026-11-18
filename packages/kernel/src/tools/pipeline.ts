/**
 * High-risk tool pipeline (Phase 15.T2/T8, ADR-0029).
 *
 * A write call is validated, previewed and priced against the approval policy
 * before anything runs. Auto-allowlisted calls execute with `approved: true`;
 * everything else becomes an ApprovalStore row with its preview and expiry.
 * After execution, `getStatus()` verifies the effect and a deterministic run
 * receipt is built from the call labels — never written by a model.
 */
import type { Approval, ApprovalExpiry } from '../approvals.js';
import { decideApproval } from '../approvals/policy.js';
import type { ApprovalDecision, ApprovalPolicy } from '../approvals/policy.js';
import { previewSummary } from '../approvals/preview.js';
import { buildRunReceipt, planToolSequence } from '../operations/autonomy.js';
import type { RunReceipt, ToolCallRecord, UndoClass } from '../operations/autonomy.js';
import { validateToolDefinition } from './registry.js';
import type { ToolRegistry } from './registry.js';
import type { ToolContext, ToolResult } from './types.js';

export interface ApprovalQueue {
  create(args: {
    runId: string;
    stepId: string;
    toolName: string;
    input: unknown;
    preview?: unknown;
    expiresAfterMs: number;
    onExpiry?: ApprovalExpiry;
  }): Promise<Approval>;
  attachReceipt?(id: string, receipt: unknown): Promise<Approval>;
}

export type ToolFailure = Extract<ToolResult<never>, { ok: false }>['error'];

export interface ToolVerification {
  status: 'applied' | 'not_applied' | 'unknown';
  idempotencyKey: string;
}

export interface InvokeWithApprovalArgs {
  tool: string;
  input: unknown;
  ctx: ToolContext;
  approvals: ApprovalQueue;
  policy: ApprovalPolicy;
  stepId?: string;
  expiresAfterMs?: number;
  onExpiry?: ApprovalExpiry;
  /** Set by the taint check; a hard-floor call can never auto-approve. */
  tainted?: boolean;
  /** Prior auto-approved calls to this tool in the same run (maxPerRun). */
  runCount?: number;
  idempotencyKey?: string;
  /** Force a human decision even when the policy would auto-approve. */
  forceApproval?: { reason: string };
}

export type InvokeWithApprovalResult<O = unknown> =
  | {
      status: 'done';
      result: ToolResult<O>;
      receipt: RunReceipt;
      decision: ApprovalDecision;
      verification?: ToolVerification;
    }
  | {
      status: 'awaiting';
      approval: Approval;
      receipt: RunReceipt;
      decision: ApprovalDecision;
    }
  | {
      status: 'blocked';
      error: ToolFailure;
      receipt: RunReceipt;
      decision: ApprovalDecision;
    };

const DEFAULT_EXPIRY_MS = 86_400_000;

/**
 * Validate → preview → decide → execute or queue. Reads run automatically;
 * writes either execute with `approved: true` or park as an approval row.
 */
export async function invokeWithApproval<O = unknown>(
  registry: ToolRegistry,
  args: InvokeWithApprovalArgs,
): Promise<InvokeWithApprovalResult<O>> {
  const tool = registry.get(args.tool);
  if (!tool) {
    return blocked(args.ctx.runId, args.tool, 'free', {
      code: 'tool.NOT_FOUND',
      category: 'not_found',
      retryable: false,
      message: `tool ${args.tool} is not registered`,
    });
  }
  const problems = validateToolDefinition(tool);
  if (problems.length > 0) {
    return blocked(args.ctx.runId, tool.name, tool.undo, {
      code: 'tool.TOOL_CONTRACT_INVALID',
      category: 'validation',
      retryable: false,
      message: problems.join('; '),
    });
  }
  const parsed = tool.input.safeParse(args.input);
  if (!parsed.success) {
    return blocked(args.ctx.runId, tool.name, tool.undo, {
      code: 'tool.INVALID_INPUT',
      category: 'validation',
      retryable: false,
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
      hint: 'Fix the arguments and retry.',
    });
  }

  // Reads run automatically and do not need a human preview; only writes are
  // priced and shown before execution.
  let preview: unknown;
  if (tool.access === 'write') {
    try {
      preview = tool.preview
        ? await tool.preview(parsed.data, args.ctx)
        : { summary: tool.description, affects: [] };
    } catch (err) {
      return blocked(args.ctx.runId, tool.name, tool.undo, {
        code: 'tool.PREVIEW_FAILED',
        category: 'validation',
        retryable: false,
        message: `preview failed for ${tool.name}: ${(err as Error).message}`,
      });
    }
  }

  const risk = tool.riskOf ? tool.riskOf(parsed.data, args.ctx) : tool.risk;
  let decision = decideApproval(args.policy, {
    tool: tool.name,
    access: tool.access,
    risk,
    undo: tool.undo,
    input: parsed.data,
    ...(args.tainted === undefined ? {} : { tainted: args.tainted }),
    ...(args.runCount === undefined ? {} : { runCount: args.runCount }),
  });
  if (args.forceApproval && tool.access === 'write' && decision.action === 'auto') {
    decision = { action: 'ask', reason: args.forceApproval.reason };
  }

  if (decision.action !== 'auto') {
    const approval = await args.approvals.create({
      runId: args.ctx.runId,
      stepId: args.stepId ?? args.ctx.stepId,
      toolName: tool.name,
      input: parsed.data,
      // Keep the policy reason with the preview so the inbox can show why the
      // call is waiting (hard-floor rows are locked as Ask required).
      preview: withPolicyReason(preview, decision),
      expiresAfterMs: args.expiresAfterMs ?? args.policy.expiresAfterMs ?? DEFAULT_EXPIRY_MS,
      onExpiry: args.onExpiry ?? args.policy.onExpiry ?? 'escalate',
    });
    const summary = previewSummary(preview) ?? tool.name;
    return {
      status: 'awaiting',
      approval,
      decision,
      receipt: buildRunReceipt({
        runId: args.ctx.runId,
        calls: [],
        waiting: [
          {
            approvalId: approval.id,
            tool: tool.name,
            count: 1,
            summary,
            parked: true,
          },
        ],
      }),
    };
  }

  const idempotencyKey =
    args.idempotencyKey ?? `${args.ctx.runId}:${args.stepId ?? args.ctx.stepId}:${tool.name}`;
  const result = await registry.invoke<O>(tool.name, parsed.data, args.ctx, {
    approved: true,
    idempotencyKey,
  });

  let verification: ToolVerification | undefined;
  if (result.ok && tool.getStatus) {
    try {
      verification = {
        status: await tool.getStatus(idempotencyKey, args.ctx),
        idempotencyKey,
      };
    } catch {
      verification = { status: 'unknown', idempotencyKey };
    }
  }
  const verified = verification?.status !== 'not_applied';
  const call: ToolCallRecord = {
    tool: tool.name,
    undo: tool.undo as UndoClass,
    status: result.ok && verified ? 'ok' : 'error',
  };
  return {
    status: 'done',
    result,
    decision,
    ...(verification ? { verification } : {}),
    receipt: buildRunReceipt({ runId: args.ctx.runId, calls: [call] }),
  };
}

export interface ToolSequenceCall {
  tool: string;
  input: unknown;
  stepId?: string;
}

export interface ExecuteToolSequenceArgs {
  calls: ToolSequenceCall[];
  ctx: ToolContext;
  approvals: ApprovalQueue;
  policy: ApprovalPolicy;
  expiresAfterMs?: number;
  onExpiry?: ApprovalExpiry;
  tainted?: boolean;
}

export interface ToolSequenceResult {
  runId: string;
  executed: Array<{ tool: string; undo: UndoClass; result: ToolResult }>;
  parked: Approval[];
  receipt: RunReceipt;
  stoppedAt: number | null;
}

/**
 * Finish reversible calls, then park at the first `undo: 'none'` call. The
 * parked approval carries the run receipt in its preview; later calls wait for
 * the human decision instead of running ahead of it (15.T8).
 */
export async function executeToolSequence(
  registry: ToolRegistry,
  args: ExecuteToolSequenceArgs,
): Promise<ToolSequenceResult> {
  const labels = args.calls.map((call) => ({
    tool: call.tool,
    undo: (registry.get(call.tool)?.undo ?? 'none') as UndoClass,
  }));
  const plan = planToolSequence(labels);
  const executed: ToolSequenceResult['executed'] = [];
  const calls: ToolCallRecord[] = [];
  const parked: Approval[] = [];
  let stoppedAt: number | null = null;

  const invoke = (index: number, forceApproval?: { reason: string }) => {
    const call = args.calls[index] as ToolSequenceCall;
    return invokeWithApproval(registry, {
      tool: call.tool,
      input: call.input,
      ctx: args.ctx,
      approvals: args.approvals,
      policy: args.policy,
      stepId: call.stepId,
      ...(args.expiresAfterMs === undefined ? {} : { expiresAfterMs: args.expiresAfterMs }),
      ...(args.onExpiry === undefined ? {} : { onExpiry: args.onExpiry }),
      ...(args.tainted === undefined ? {} : { tainted: args.tainted }),
      ...(forceApproval ? { forceApproval } : {}),
    });
  };

  for (const index of plan.execute) {
    const outcome = await invoke(index);
    if (outcome.status === 'done') {
      const call = args.calls[index] as ToolSequenceCall;
      executed.push({
        tool: call.tool,
        undo: labels[index]?.undo ?? 'none',
        result: outcome.result,
      });
      calls.push({
        tool: call.tool,
        undo: labels[index]?.undo ?? 'none',
        status:
          outcome.result.ok && outcome.verification?.status !== 'not_applied' ? 'ok' : 'error',
      });
      if (!outcome.result.ok) {
        stoppedAt = index;
        break;
      }
      continue;
    }
    if (outcome.status === 'awaiting') parked.push(outcome.approval);
    stoppedAt = index;
    break;
  }

  if (stoppedAt === null && plan.parkAt !== null) {
    const index = plan.parkAt;
    const outcome = await invoke(index, { reason: 'irreversible_park' });
    if (outcome.status === 'awaiting') parked.push(outcome.approval);
    stoppedAt = index;
  }

  const receipt = buildRunReceipt({
    runId: args.ctx.runId,
    calls,
    waiting: parked.map((approval) => ({
      approvalId: approval.id,
      tool: approval.toolName,
      count: 1,
      summary: previewSummary(approval.preview) ?? approval.toolName,
      parked: true,
    })),
  });
  if (args.approvals.attachReceipt) {
    await Promise.all(
      parked.map((approval) => args.approvals.attachReceipt?.(approval.id, receipt)),
    );
  }
  return { runId: args.ctx.runId, executed, parked, receipt, stoppedAt };
}

function withPolicyReason(preview: unknown, decision: ApprovalDecision): unknown {
  const base =
    typeof preview === 'object' && preview !== null && !Array.isArray(preview)
      ? preview
      : { preview };
  return { ...base, policy: { action: decision.action, reason: decision.reason } };
}

function blocked(
  runId: string,
  tool: string,
  undo: UndoClass,
  error: ToolFailure,
): InvokeWithApprovalResult<never> {
  return {
    status: 'blocked',
    error,
    decision: { action: 'deny', reason: `blocked:${error.code}` },
    receipt: buildRunReceipt({
      runId,
      calls: [{ tool, undo, status: 'blocked' }],
    }),
  };
}
