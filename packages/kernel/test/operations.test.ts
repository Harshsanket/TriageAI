import { describe, expect, it } from 'vitest';

import { coordinationOverhead, routineReceipt } from '../src/operations/metrics.js';
import { chooseTopology } from '../src/operations/teams.js';
import { watchdogScan, type AgentWatchEvent } from '../src/operations/watchdog.js';

describe('coordination overhead + routine receipts (phase 17/19)', () => {
  it('computes overhead and alerts above 30%', () => {
    expect(
      coordinationOverhead({
        supervisionTokens: 20,
        handoffTokens: 10,
        reviewTokens: 0,
        taskTokens: 100,
      }),
    ).toMatchObject({ overhead: 0.3, alert: false });
    expect(
      coordinationOverhead({
        supervisionTokens: 50,
        handoffTokens: 0,
        reviewTokens: 0,
        taskTokens: 100,
      }),
    ).toMatchObject({ alert: true });
  });

  it('suggests retire/slow_down/add_probe from a routine window', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    expect(
      routineReceipt(
        {
          runs: 10,
          noChange: 10,
          useful: 0,
          neededHuman: 0,
          repeatedFailures: 0,
          skippedOverlap: 0,
          manualRuns: 0,
          cost: 2,
          lastUsefulAt: '2026-08-01T00:00:00Z',
        },
        now,
      ),
    ).toMatchObject({ suggestion: 'retire', estSaving: 2 });
    expect(
      routineReceipt(
        {
          runs: 10,
          noChange: 9,
          useful: 1,
          neededHuman: 0,
          repeatedFailures: 0,
          skippedOverlap: 0,
          manualRuns: 0,
          cost: 2,
          lastUsefulAt: '2026-10-29T00:00:00Z',
        },
        now,
      ),
    ).toMatchObject({ suggestion: 'slow_down' });
    expect(
      routineReceipt(
        {
          runs: 5,
          noChange: 0,
          useful: 1,
          neededHuman: 0,
          repeatedFailures: 0,
          skippedOverlap: 0,
          manualRuns: 0,
          cost: 1,
          lastUsefulAt: '2026-10-29T00:00:00Z',
          modelCalling: true,
          hasProbe: false,
        },
        now,
      ),
    ).toMatchObject({ suggestion: 'add_probe' });
  });
});

describe('team topology router (phase 17)', () => {
  it('picks the simplest topology that fits', () => {
    expect(
      chooseTopology({
        agentCount: 1,
        independentSubtasks: 0,
        parallelizable: false,
        needsReview: false,
      }).topology,
    ).toBe('single');
    expect(
      chooseTopology({
        agentCount: 2,
        independentSubtasks: 0,
        parallelizable: false,
        needsReview: true,
      }).topology,
    ).toBe('reviewer');
    expect(
      chooseTopology({
        agentCount: 2,
        independentSubtasks: 3,
        parallelizable: true,
        needsReview: false,
      }).topology,
    ).toBe('fanout');
    expect(
      chooseTopology({
        agentCount: 2,
        independentSubtasks: 3,
        parallelizable: false,
        needsReview: false,
      }).topology,
    ).toBe('supervisor');
    expect(() =>
      chooseTopology({
        agentCount: 7,
        independentSubtasks: 0,
        parallelizable: false,
        needsReview: false,
      }),
    ).toThrow(/at most 6/);
  });
});

describe('watchdog (phase 17)', () => {
  const event = (overrides: Partial<AgentWatchEvent>): AgentWatchEvent => ({
    at: '2026-10-30T00:00:00Z',
    kind: 'step',
    agentId: 'a',
    ...overrides,
  });

  it('pauses after three identical tool calls in a row', () => {
    const decision = watchdogScan([
      event({ kind: 'tool_call', tool: 'crm.get_deal', argsHash: 'x' }),
      event({ kind: 'tool_call', tool: 'crm.get_deal', argsHash: 'x' }),
      event({ kind: 'tool_call', tool: 'crm.get_deal', argsHash: 'x' }),
    ]);
    expect(decision).toMatchObject({ action: 'pause', reason: 'three_identical_tool_calls' });
  });

  it('escalates handoff ping-pong with no state change', () => {
    const decision = watchdogScan([
      event({ kind: 'handoff', workItemId: 'w', agentId: 'a', stateHash: 's', proofRefs: ['p'] }),
      event({ kind: 'handoff', workItemId: 'w', agentId: 'b', stateHash: 's', proofRefs: ['p'] }),
      event({ kind: 'handoff', workItemId: 'w', agentId: 'a', stateHash: 's', proofRefs: ['p'] }),
      event({ kind: 'handoff', workItemId: 'w', agentId: 'b', stateHash: 's', proofRefs: ['p'] }),
    ]);
    expect(decision).toMatchObject({ action: 'escalate', reason: 'handoff_ping_pong' });
  });
});
