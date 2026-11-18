/**
 * Approval policy (Phase 15.T2/T3, 18.3): modes, allowlist, hard floor.
 *
 * The policy is pure and deterministic: the caller supplies the tool labels
 * and the policy answers `auto | ask | deny`. A hard-floor row can never be
 * auto-approved; `deny` means "not executed automatically", so the caller
 * still queues it for a human (the inbox shows it locked as Ask required).
 */
import { z } from 'zod';

import type { ApprovalExpiry } from '../approvals.js';
import type { ToolAccess, ToolRisk, ToolUndo } from '../tools/types.js';
import type { Database } from '../types.js';

export type ApprovalMode = 'ask' | 'auto_allowlist' | 'suggest';
export type ApprovalAction = 'auto' | 'ask' | 'deny';

/** A tool name (`kb.search`) or a namespace wildcard (`kb.*`). */
const TOOL_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/;
const CONDITION_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export const AllowlistEntrySchema = z
  .object({
    tool: z
      .string()
      .min(3)
      .max(120)
      .regex(TOOL_PATTERN, 'use a tool name or a trailing .* wildcard'),
    /** Shallow, dot-path equality against the parsed tool input. */
    conditions: z.record(z.string().regex(CONDITION_PATH), z.unknown()).optional(),
    /** Auto-approve at most this many calls to the tool in one run. */
    maxPerRun: z.number().int().positive().max(1000).optional(),
  })
  .strict();

export const ApprovalPolicySchema = z
  .object({
    mode: z.enum(['ask', 'auto_allowlist', 'suggest']),
    allowlist: z.array(AllowlistEntrySchema).max(200).default([]),
    /**
     * Extra hard-floor patterns, on top of the built-in action classes. Glob
     * `*` is accepted here (e.g. `*refund*`) because these are operator rules.
     */
    hardFloor: z
      .array(
        z
          .string()
          .min(3)
          .max(120)
          .regex(/^[a-z0-9_.*]+$/),
      )
      .max(100)
      .default([]),
    expiresAfterMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 86_400_000)
      .default(86_400_000),
    onExpiry: z.enum(['escalate', 'cancel', 'park_as_draft']).default('escalate'),
  })
  .strict()
  .superRefine((policy, ctx) => {
    for (const problem of approvalPolicyProblems(policy)) {
      ctx.addIssue({ code: 'custom', message: problem });
    }
  });

export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = ApprovalPolicySchema.parse({
  mode: 'ask',
  allowlist: [],
  hardFloor: [],
});

export const APPROVAL_POLICY_SETTING_KEY = 'approval.policy';

/**
 * Read the policy from the core settings table (no migration). Missing or
 * malformed state falls back to Ask, so a bad write can never widen autonomy.
 */
export async function loadApprovalPolicy(
  database: Pick<Database, 'query'>,
): Promise<ApprovalPolicy> {
  const rows = await database
    .query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [
      APPROVAL_POLICY_SETTING_KEY,
    ])
    .catch(() => []);
  const parsed = ApprovalPolicySchema.safeParse(rows[0]?.value);
  return parsed.success ? parsed.data : DEFAULT_APPROVAL_POLICY;
}

/**
 * Action classes that never auto-approve (18.3 hard floor): deleting data,
 * payments/refunds, permission and configuration changes, and tainted input.
 * Names are matched against the tool name; a tool author cannot under-declare
 * its way out of these rows.
 */
export const HARD_FLOOR_PATTERNS: readonly string[] = [
  '*.delete',
  '*.delete_*',
  '*refund*',
  '*payment*',
  '*charge*',
  '*permission*',
  '*_config*',
  '*_role*',
];

export interface ApprovalCall {
  tool: string;
  access: ToolAccess;
  risk: ToolRisk;
  undo: ToolUndo;
  /** Parsed input; allowlist conditions read it. */
  input?: unknown;
  /** Flagged by the taint check (18.3 hard floor). */
  tainted?: boolean;
  /** Prior auto-approved calls to this tool in the same run. */
  runCount?: number;
}

export interface ApprovalDecision {
  action: ApprovalAction;
  reason: string;
}

export interface PolicyExpiryDefaults {
  expiresAfterMs: number;
  onExpiry: ApprovalExpiry;
}

export function approvalPolicyProblems(policy: ApprovalPolicy): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of policy.allowlist.entries()) {
    if (!entry.tool.includes('.')) {
      problems.push(`allowlist[${index}] must name a tool or namespace (e.g. kb.search or kb.*)`);
    }
    if (entry.tool === '*') {
      problems.push(`allowlist[${index}] cannot allow every tool`);
    }
    if (seen.has(entry.tool)) {
      problems.push(`allowlist[${index}] duplicates ${entry.tool}`);
    }
    seen.add(entry.tool);
    for (const path of Object.keys(entry.conditions ?? {})) {
      if (!CONDITION_PATH.test(path)) {
        problems.push(`allowlist[${index}] condition path "${path}" is invalid`);
      }
    }
  }
  return problems;
}

/** Match an exact tool name, a trailing namespace wildcard, or an operator glob. */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (!pattern.includes('*')) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(toolName);
}

export function hardFloorReason(policy: ApprovalPolicy, call: ApprovalCall): string | null {
  if (call.tainted) return 'tainted_input';
  if (HARD_FLOOR_PATTERNS.some((pattern) => matchesToolPattern(pattern, call.tool))) {
    return 'protected_action';
  }
  if (policy.hardFloor.some((pattern) => matchesToolPattern(pattern, call.tool))) {
    return 'policy';
  }
  return null;
}

export function decideApproval(policy: ApprovalPolicy, call: ApprovalCall): ApprovalDecision {
  // Reads never need approval; the taint floor only gates consequential calls.
  if (call.access === 'read') return { action: 'auto', reason: 'read_is_automatic' };

  const floor = hardFloorReason(policy, call);
  if (floor) return { action: 'deny', reason: `hard_floor:${floor}` };

  if (policy.mode === 'ask') return { action: 'ask', reason: 'mode_ask' };
  if (policy.mode === 'suggest') return { action: 'deny', reason: 'suggest_only' };

  const entry = policy.allowlist.find((candidate) => matchesToolPattern(candidate.tool, call.tool));
  if (!entry) return { action: 'ask', reason: 'not_allowlisted' };
  if (entry.conditions && !matchesConditions(call.input, entry.conditions)) {
    return { action: 'ask', reason: 'conditions_unmet' };
  }
  if (entry.maxPerRun !== undefined && (call.runCount ?? 0) >= entry.maxPerRun) {
    return { action: 'ask', reason: 'max_per_run_reached' };
  }
  return { action: 'auto', reason: 'allowlisted' };
}

export function matchesConditions(input: unknown, conditions: Record<string, unknown>): boolean {
  if (!isRecord(input)) return false;
  return Object.entries(conditions).every(([path, expected]) => {
    const actual = path.split('.').reduce<unknown>((value, key) => {
      return isRecord(value) ? value[key] : undefined;
    }, input);
    return jsonEqual(actual, expected);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && jsonEqual(left[key], right[key]))
    );
  }
  return false;
}
