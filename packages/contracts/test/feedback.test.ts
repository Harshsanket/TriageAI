import { describe, expect, it } from 'vitest';

import {
  CandidateReviewRequestSchema,
  DatasetBuildRequestSchema,
  EvalReportInputSchema,
  PromoteModelRequestSchema,
  exportJsonSchemas,
} from '../src/index.js';

describe('feedback contracts (phase 6)', () => {
  it('constrains review decisions and methods', () => {
    expect(
      CandidateReviewRequestSchema.parse({
        status: 'approved',
        actor: 'a',
        method: 'better_answer',
      }),
    ).toMatchObject({ status: 'approved', method: 'better_answer' });
    expect(() => CandidateReviewRequestSchema.parse({ status: 'maybe' })).toThrow();
    expect(() =>
      CandidateReviewRequestSchema.parse({ status: 'approved', method: 'invented' }),
    ).toThrow();
  });

  it('applies dataset defaults and rejects invalid ratios', () => {
    expect(DatasetBuildRequestSchema.parse({})).toEqual({
      purpose: 'classifier',
      createdBy: 'admin',
    });
    expect(() =>
      DatasetBuildRequestSchema.parse({ ratios: { train: 0, val: 0.5, test: 0.5 } }),
    ).toThrow();
  });

  it('requires suites and metrics on eval reports', () => {
    const report = EvalReportInputSchema.parse({
      generatedAt: '2026-10-24T00:00:00Z',
      suites: [{ suite: 'classification', status: 'passed', metrics: { macroF1: 0.8 } }],
      metrics: { macroF1: 0.8, falseAutoRoutingCount: 0 },
      passes: true,
    });
    expect(report.suites).toHaveLength(1);
    expect(() =>
      EvalReportInputSchema.parse({ generatedAt: 'now', suites: [], metrics: {}, passes: true }),
    ).toThrow();
  });

  it('requires a model promotion actor default and exports JSON Schemas', () => {
    expect(PromoteModelRequestSchema.parse({})).toEqual({ actor: 'admin' });
    const schemas = exportJsonSchemas();
    expect(schemas).toHaveProperty('CandidateReviewRequest');
    expect(schemas).toHaveProperty('DatasetDto');
    expect(schemas).toHaveProperty('EvalReportInput');
  });
});
