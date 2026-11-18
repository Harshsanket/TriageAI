/**
 * Approval expiry payloads (Phase 15.T9, 18.3): escalate, cancel, or keep the
 * prepared action as a draft. `park_as_draft` stores the draft in the approval
 * row's preview/reason — no new table and no migration.
 */
import type { Approval } from '../approvals.js';
import { previewSummary } from './preview.js';

export interface ApprovalDraft {
  approvalId: string;
  runId: string;
  toolName: string;
  input: unknown;
  preview: unknown;
  summary: string | null;
}

export type ExpiryOutcome =
  | {
      action: 'escalate';
      reason: 'approval_expired_escalate';
      approvalId: string;
      runId: string;
      toolName: string;
    }
  | {
      action: 'cancel';
      reason: 'approval_expired_cancel';
      approvalId: string;
      runId: string;
      toolName: string;
    }
  | {
      action: 'park_as_draft';
      reason: 'parked_as_draft';
      approvalId: string;
      runId: string;
      toolName: string;
      draft: ApprovalDraft;
    };

export function applyExpiry(approval: Approval): ExpiryOutcome {
  if (approval.onExpiry === 'park_as_draft') {
    return {
      action: 'park_as_draft',
      reason: 'parked_as_draft',
      approvalId: approval.id,
      runId: approval.runId,
      toolName: approval.toolName,
      draft: {
        approvalId: approval.id,
        runId: approval.runId,
        toolName: approval.toolName,
        input: approval.input,
        preview: approval.preview,
        summary: previewSummary(approval.preview),
      },
    };
  }
  if (approval.onExpiry === 'cancel') {
    return {
      action: 'cancel',
      reason: 'approval_expired_cancel',
      approvalId: approval.id,
      runId: approval.runId,
      toolName: approval.toolName,
    };
  }
  return {
    action: 'escalate',
    reason: 'approval_expired_escalate',
    approvalId: approval.id,
    runId: approval.runId,
    toolName: approval.toolName,
  };
}
