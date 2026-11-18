import { describe, expect, it } from 'vitest';

import { assertRunTransition, canTransitionRun, RUN_TRANSITIONS } from '../src/runState.js';

describe('run status machine (18.T3)', () => {
  it('allows the declared lifecycle and blocks terminal rewrites', () => {
    expect(canTransitionRun('PENDING', 'RUNNING')).toBe(true);
    expect(canTransitionRun('RUNNING', 'AWAITING')).toBe(true);
    expect(canTransitionRun('AWAITING', 'RUNNING')).toBe(true);
    expect(canTransitionRun('RUNNING', 'CANCELLED_PENDING')).toBe(true);
    expect(canTransitionRun('CANCELLED_PENDING', 'CANCELLED')).toBe(true);
    expect(canTransitionRun('SUCCEEDED', 'RUNNING')).toBe(false);
    expect(canTransitionRun('FAILED', 'SUCCEEDED')).toBe(false);
    expect(() => assertRunTransition('CANCELLED', 'RUNNING')).toThrow(
      /cannot transition CANCELLED/,
    );
  });

  it('keeps every terminal state terminal', () => {
    for (const terminal of ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const) {
      expect(RUN_TRANSITIONS[terminal]).toEqual([]);
    }
  });
});
