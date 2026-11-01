import type { ZodType } from 'zod';

import type { ErrorCategory } from '../errors.js';
import type { KernelLogger } from '../types.js';

export type ToolAccess = 'read' | 'write';
export type ToolRisk = 'low' | 'high';
export type ToolUndo = 'free' | 'compensable' | 'none';
import type { Sensitivity } from '../data/classes.js';

export interface ToolContext {
  runId: string;
  stepId: string;
  agentId?: string;
  workspaceId?: string;
  actorId?: string;
  ownerScope?: string;
  role?: string;
  /** Whether the result will be sent to a hosted model (send gate, R8). */
  hosted?: boolean;
  grantedScopes: string[];
  egressClass: Sensitivity;
  org: { ownsEmail(address: string): boolean };
  logger: KernelLogger;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolApprovalDecision {
  approved: boolean;
  approver?: string;
  reason?: string;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  version: string;
  owner: string;
  description: string;
  examples: I[];
  input: ZodType<I>;
  output: ZodType<O>;
  access: ToolAccess;
  risk: ToolRisk;
  riskOf?(input: I, ctx: ToolContext): ToolRisk;
  scopes: string[];
  egressClass: Sensitivity;
  allowedHosts?: string[];
  rateLimit?: { perMinute: number };
  idempotent: boolean;
  timeoutMs: number;
  undo: ToolUndo;
  retry: {
    maxAttempts: number;
    backoff: 'none' | 'fixed' | 'exponential';
    retryOn: ErrorCategory[];
  };
  validate?(input: I, ctx: ToolContext): Promise<void>;
  preview?(
    input: I,
    ctx: ToolContext,
  ): Promise<{ summary: string; affects: string[]; count?: number }>;
  getStatus?(
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<'applied' | 'not_applied' | 'unknown'>;
  compensate?(result: O, ctx: ToolContext): Promise<void>;
  costHint?: string;
  deprecated?: { replacedBy: string };
  handler(input: I, ctx: ToolContext & { signal: AbortSignal; idempotencyKey: string }): Promise<O>;
}

export type ToolResult<O = unknown> =
  | {
      ok: true;
      data: O;
      refs?: string[];
      truncated?: boolean;
      nextCursor?: string;
    }
  | {
      ok: false;
      error: {
        code: string;
        category: ErrorCategory;
        retryable: boolean;
        message: string;
        hint?: string;
      };
    };

export interface ToolInfo {
  name: string;
  version: string;
  owner: string;
  description: string;
  access: ToolAccess;
  risk: ToolRisk;
  scopes: string[];
  timeoutMs: number;
  undo: ToolUndo;
  idempotent: boolean;
  deprecated?: { replacedBy: string };
}
