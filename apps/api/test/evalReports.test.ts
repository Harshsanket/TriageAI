import { describe, expect, it } from 'vitest';

import { evalReportMarkdown, mergeEvalSuites } from '../src/services/evalReports.js';
import { evaluatePromotion } from '../src/services/modelRegistry.js';

describe('merged eval report format', () => {
  it('merges suite metrics into one report and passes only when every suite passes', () => {
    const merged = mergeEvalSuites(
      [
        {
          suite: 'classification',
          status: 'passed',
          metrics: { macroF1: 0.82, falseAutoRoutingCount: 0, p95LatencyMs: 12 },
          gates: { macroF1: 0.7 },
        },
        {
          suite: 'retrieval',
          status: 'passed',
          metrics: { recallAt3: 0.9, mrr: 0.7 },
          gates: { recallAt3: 0.8 },
        },
        {
          suite: 'generation',
          status: 'passed',
          metrics: { groundedness: 0.95 },
          gates: { groundedness: 0.8 },
        },
      ],
      { generatedAt: '2026-10-24T00:00:00Z' },
    );
    expect(merged.passes).toBe(true);
    expect(merged.metrics).toMatchObject({
      macroF1: 0.82,
      falseAutoRoutingCount: 0,
      recallAt3: 0.9,
      groundedness: 0.95,
    });
    expect(merged.suites.map((suite) => suite.suite)).toEqual([
      'classification',
      'retrieval',
      'generation',
    ]);
    expect(evalReportMarkdown(merged)).toContain('| classification | passed |');
  });

  it('marks the report failed when a suite fails', () => {
    const merged = mergeEvalSuites([
      { suite: 'classification', status: 'passed', metrics: { macroF1: 0.9 } },
      { suite: 'retrieval', status: 'failed', metrics: { recallAt3: 0.4 } },
    ]);
    expect(merged.passes).toBe(false);
  });
});

describe('promotion policy', () => {
  const passing = {
    passes: true,
    metrics: { macroF1: 0.8, falseAutoRoutingCount: 0 },
  };

  it('allows the first active model and any non-regressing better model', () => {
    expect(evaluatePromotion(passing, null).allowed).toBe(true);
    expect(
      evaluatePromotion(
        { passes: true, metrics: { macroF1: 0.85, falseAutoRoutingCount: 0 } },
        passing,
      ).allowed,
    ).toBe(true);
  });

  it('blocks regressions and unsafe safety metrics', () => {
    const worse = evaluatePromotion({ passes: true, metrics: { macroF1: 0.7 } }, passing);
    expect(worse.allowed).toBe(false);
    expect(worse.reasons.join(' ')).toContain('regresses');

    const unsafe = evaluatePromotion(
      { passes: true, metrics: { macroF1: 0.99, falseAutoRoutingCount: 1 } },
      passing,
    );
    expect(unsafe.allowed).toBe(false);
    expect(unsafe.reasons.join(' ')).toContain('false auto-routing');

    const failing = evaluatePromotion({ passes: false, metrics: { macroF1: 0.99 } }, passing);
    expect(failing.allowed).toBe(false);
  });

  it('consults step-level trajectory floors only when a report is attached', () => {
    expect(evaluatePromotion(passing, null).allowed).toBe(true);

    const lowEfficiency = evaluatePromotion(
      { passes: true, metrics: { macroF1: 0.9 }, trajectory: { pathEfficiency: 0.5 } },
      null,
    );
    expect(lowEfficiency.allowed).toBe(false);
    expect(lowEfficiency.reasons.join(' ')).toContain('path efficiency');

    const lowToolSelection = evaluatePromotion(
      { passes: true, metrics: { macroF1: 0.9 }, trajectory: { toolSelectionAccuracy: 0.7 } },
      null,
    );
    expect(lowToolSelection.allowed).toBe(false);
    expect(lowToolSelection.reasons.join(' ')).toContain('tool-selection accuracy');

    const tooManyWasted = evaluatePromotion(
      { passes: true, metrics: { macroF1: 0.9, trajectoryWastedSteps: 5 } },
      null,
    );
    expect(tooManyWasted.allowed).toBe(false);
    expect(tooManyWasted.reasons.join(' ')).toContain('wasted steps');

    const badStep = evaluatePromotion(
      {
        passes: true,
        metrics: { macroF1: 0.9 },
        trajectory: { steps: [{ nodeId: 'answer', score: 0.4 }] },
      },
      null,
    );
    expect(badStep.allowed).toBe(false);
    expect(badStep.reasons.join(' ')).toContain('step answer');

    expect(
      evaluatePromotion(
        {
          passes: true,
          metrics: { macroF1: 0.9 },
          trajectory: { pathEfficiency: 0.95, wastedSteps: 0, toolSelectionAccuracy: 0.95 },
        },
        null,
      ).allowed,
    ).toBe(true);
  });

  it('blocks a step-level regression against the baseline trajectory', () => {
    const baseline = {
      passes: true,
      metrics: { macroF1: 0.8 },
      trajectory: { pathEfficiency: 0.95, toolSelectionAccuracy: 0.95 },
    };
    const decision = evaluatePromotion(
      {
        passes: true,
        metrics: { macroF1: 0.9 },
        trajectory: { pathEfficiency: 0.9, toolSelectionAccuracy: 0.9 },
      },
      baseline,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons.join(' ')).toContain('regresses below baseline');
  });
});
