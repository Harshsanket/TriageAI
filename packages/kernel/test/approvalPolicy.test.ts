import { describe, expect, it } from 'vitest';

import {
  ApprovalPolicySchema,
  DEFAULT_APPROVAL_POLICY,
  decideApproval,
  hardFloorReason,
  matchesConditions,
  matchesToolPattern,
} from '../src/approvals/policy.js';
import type { ApprovalCall } from '../src/approvals/policy.js';

const writeCall = (overrides: Partial<ApprovalCall> = {}): ApprovalCall => ({
  tool: 'kb.create_document',
  access: 'write',
  risk: 'low',
  undo: 'compensable',
  input: { title: 'Refunds' },
  ...overrides,
});

describe('approval policy (phase 15.T3)', () => {
  it('asks by default and auto-approves reads', () => {
    expect(decideApproval(DEFAULT_APPROVAL_POLICY, writeCall())).toEqual({
      action: 'ask',
      reason: 'mode_ask',
    });
    expect(
      decideApproval(DEFAULT_APPROVAL_POLICY, {
        tool: 'kb.search',
        access: 'read',
        risk: 'high',
        undo: 'free',
      }),
    ).toEqual({ action: 'auto', reason: 'read_is_automatic' });
  });

  it('auto-approves allowlisted exact names and namespace wildcards', () => {
    const policy = ApprovalPolicySchema.parse({
      mode: 'auto_allowlist',
      allowlist: [{ tool: 'kb.create_document' }, { tool: 'crm.*' }],
    });
    expect(decideApproval(policy, writeCall())).toEqual({
      action: 'auto',
      reason: 'allowlisted',
    });
    expect(
      decideApproval(policy, writeCall({ tool: 'crm.create_deal', undo: 'compensable' })),
    ).toEqual({ action: 'auto', reason: 'allowlisted' });
    expect(decideApproval(policy, writeCall({ tool: 'email.send', undo: 'none' }))).toEqual({
      action: 'ask',
      reason: 'not_allowlisted',
    });
  });

  it('checks argument conditions and the per-run cap', () => {
    const policy = ApprovalPolicySchema.parse({
      mode: 'auto_allowlist',
      allowlist: [
        { tool: 'kb.create_document', conditions: { title: 'Refunds' } },
        { tool: 'crm.create_deal', maxPerRun: 2 },
      ],
    });
    expect(decideApproval(policy, writeCall()).action).toBe('auto');
    expect(decideApproval(policy, writeCall({ input: { title: 'Other' } }))).toEqual({
      action: 'ask',
      reason: 'conditions_unmet',
    });
    expect(decideApproval(policy, writeCall({ tool: 'crm.create_deal', runCount: 1 })).action).toBe(
      'auto',
    );
    expect(decideApproval(policy, writeCall({ tool: 'crm.create_deal', runCount: 2 }))).toEqual({
      action: 'ask',
      reason: 'max_per_run_reached',
    });
  });

  it('never auto-approves the hard floor, even when allowlisted', () => {
    const policy = ApprovalPolicySchema.parse({
      mode: 'auto_allowlist',
      allowlist: [{ tool: 'crm.delete_deal' }, { tool: 'billing.charge_card' }, { tool: 'x.*' }],
    });
    expect(decideApproval(policy, writeCall({ tool: 'crm.delete_deal', undo: 'none' }))).toEqual({
      action: 'deny',
      reason: 'hard_floor:protected_action',
    });
    expect(
      decideApproval(policy, writeCall({ tool: 'billing.charge_card', undo: 'none' })),
    ).toEqual({ action: 'deny', reason: 'hard_floor:protected_action' });
    expect(decideApproval(policy, writeCall({ tool: 'x.create_thing', tainted: true }))).toEqual({
      action: 'deny',
      reason: 'hard_floor:tainted_input',
    });
    expect(hardFloorReason(policy, writeCall({ tool: 'x.update_config' }))).toBe(
      'protected_action',
    );
  });

  it('suggest mode proposes but never executes writes', () => {
    const policy = ApprovalPolicySchema.parse({
      mode: 'suggest',
      allowlist: [{ tool: 'kb.create_document' }],
    });
    expect(decideApproval(policy, writeCall())).toEqual({
      action: 'deny',
      reason: 'suggest_only',
    });
  });

  it('rejects an allowlist that would allow everything or duplicate entries', () => {
    expect(
      ApprovalPolicySchema.safeParse({ mode: 'auto_allowlist', allowlist: [{ tool: '*' }] })
        .success,
    ).toBe(false);
    expect(
      ApprovalPolicySchema.safeParse({
        mode: 'auto_allowlist',
        allowlist: [{ tool: 'kb.create_document' }, { tool: 'kb.create_document' }],
      }).success,
    ).toBe(false);
    expect(ApprovalPolicySchema.safeParse({ mode: 'auto-allowlist', allowlist: [] }).success).toBe(
      false,
    );
  });

  it('matches nested conditions without depending on key order', () => {
    expect(
      matchesConditions(
        { meta: { owner: { email: 'a@example.com' }, tags: ['billing'] } },
        { 'meta.owner.email': 'a@example.com', 'meta.tags': ['billing'] },
      ),
    ).toBe(true);
    expect(matchesConditions({ meta: {} }, { 'meta.owner.email': 'a@example.com' })).toBe(false);
    expect(matchesToolPattern('kb.*', 'kb.create_document')).toBe(true);
    expect(matchesToolPattern('kb.*', 'crm.create_deal')).toBe(false);
  });
});
