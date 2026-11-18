import { describe, expect, it } from 'vitest';

import type { Approval } from '../src/approvals.js';
import { applyExpiry } from '../src/approvals/expiry.js';

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'a1',
    runId: 'r1',
    stepId: 's1',
    toolName: 'email.send',
    input: { body: 'Hello' },
    preview: { summary: 'Send a reply', affects: ['ticket-1'] },
    status: 'expired',
    onExpiry: 'escalate',
    approver: null,
    reason: null,
    expiresAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    decidedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('approval expiry (phase 15.T9)', () => {
  it('escalates by default and cancels on request', () => {
    expect(applyExpiry(approval())).toMatchObject({
      action: 'escalate',
      reason: 'approval_expired_escalate',
      approvalId: 'a1',
    });
    expect(applyExpiry(approval({ onExpiry: 'cancel' }))).toMatchObject({
      action: 'cancel',
      reason: 'approval_expired_cancel',
    });
  });

  it('keeps a park_as_draft payload with the prepared action', () => {
    const outcome = applyExpiry(approval({ onExpiry: 'park_as_draft' }));
    expect(outcome.action).toBe('park_as_draft');
    if (outcome.action !== 'park_as_draft') return;
    expect(outcome.reason).toBe('parked_as_draft');
    expect(outcome.draft).toMatchObject({
      approvalId: 'a1',
      runId: 'r1',
      toolName: 'email.send',
      input: { body: 'Hello' },
      summary: 'Send a reply',
    });
  });
});
