import { describe, expect, it } from 'vitest';

import { detectDrift, rollingBaseline, shouldAutoRollback } from '../src/evals/drift.js';
import { scoreDeterministic, shouldEvaluate } from '../src/evals/sampling.js';

describe('online eval sampling (phase 18.1)', () => {
  it('samples deterministically and always scores risky runs', () => {
    expect(shouldEvaluate({ runId: 'a', hostedModel: true }, 0.1)).toBe(true);
    expect(shouldEvaluate({ runId: 'a', highRiskTool: true }, 0.01)).toBe(true);
    expect(shouldEvaluate({ runId: 'a' }, 0.1)).toBe(shouldEvaluate({ runId: 'a' }, 0.1));
    expect(shouldEvaluate({ runId: 'a' }, 0)).toBe(false);
  });

  it('scores deterministic checks and reports findings', () => {
    expect(
      scoreDeterministic('r', {
        validatorPassed: false,
        citationsPresent: false,
        refusedCorrectly: false,
        piiFree: false,
      }),
    ).toMatchObject({
      passed: false,
      findings: ['validator_failed', 'missing_citation_or_refusal', 'pii_present'],
    });
    expect(
      scoreDeterministic('r', {
        validatorPassed: true,
        citationsPresent: true,
        refusedCorrectly: false,
        piiFree: true,
      }).passed,
    ).toBe(true);
  });
});

describe('drift and auto-rollback (phase 18.1)', () => {
  it('detects a z-score or absolute break', () => {
    const baseline = rollingBaseline([0.9, 0.91, 0.89, 0.9, 0.9]);
    expect(detectDrift(0.9, baseline).drift).toBe(false);
    expect(detectDrift(0.2, baseline).drift).toBe(true);
    expect(detectDrift(0.5, baseline, { absoluteThreshold: 0.2 })).toMatchObject({ drift: true });
  });

  it('rolls back after three consecutive below-floor windows', () => {
    expect(shouldAutoRollback([0.9, 0.5, 0.4, 0.3], 0.8)).toBe(true);
    expect(shouldAutoRollback([0.9, 0.5, 0.4], 0.8)).toBe(false);
  });
});
