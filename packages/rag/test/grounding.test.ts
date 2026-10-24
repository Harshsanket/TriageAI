import { describe, expect, it } from 'vitest';

import { assessAnswer, finalizeAnswer } from '../src/index.js';

const refundSource = {
  ref: 'Refund policy',
  text: 'Refunds are processed within five business days after approval. Contact billing for refund questions.',
};

describe('grounding assessment (format-independent)', () => {
  it('marks a verbatim, uncited answer as grounded but uncited', () => {
    const assessment = assessAnswer(
      'Refunds are processed within five business days after approval.',
      [refundSource],
    );
    expect(assessment.grounded).toBe(true);
    expect(assessment.cited).toBe(false);
    expect(assessment.coverage).toBeGreaterThan(0.6);
  });

  it('detects citations when the model provides them', () => {
    const assessment = assessAnswer('Refunds take five business days [Refund policy].', [
      refundSource,
    ]);
    expect(assessment.cited).toBe(true);
    expect(assessment.grounded).toBe(true);
  });

  it('rejects an answer that is not supported by the sources', () => {
    const assessment = assessAnswer('The moon is made of edible cheese.', [refundSource]);
    expect(assessment.grounded).toBe(false);
    expect(assessment.coverage).toBeLessThan(0.6);
  });

  it('treats empty answers as ungrounded', () => {
    expect(assessAnswer('   ', [refundSource]).grounded).toBe(false);
  });
});

describe('finalizeAnswer policy', () => {
  it('keeps a grounded answer and attaches the citation deterministically', () => {
    const finalized = finalizeAnswer({
      answer: 'Refunds are processed within five business days after approval.',
      sources: [refundSource],
    });
    expect(finalized.refused).toBe(false);
    expect(finalized.citationSource).toBe('deterministic');
    expect(finalized.answer).toContain('[Refund policy]');
    expect(finalized.citations).toEqual(['Refund policy']);
  });

  it('cites only the sources that actually support the answer', () => {
    const finalized = finalizeAnswer({
      answer: 'Refunds are processed within five business days after approval.',
      sources: [
        { ref: 'Refund policy', text: refundSource.text },
        { ref: 'Account recovery', text: 'Use the password reset link if you cannot sign in.' },
        { ref: 'Startup crash', text: 'Clear the local cache and restart the service.' },
      ],
    });
    expect(finalized.citations).toEqual(['Refund policy']);
    expect(finalized.answer).toContain('[Refund policy]');
    expect(finalized.answer).not.toContain('[Account recovery]');
  });

  it('does not touch an answer that already cites its sources', () => {
    const finalized = finalizeAnswer({
      answer: 'Refunds take five business days [Refund policy].',
      sources: [refundSource],
    });
    expect(finalized.citationSource).toBe('model');
    expect(finalized.answer).toBe('Refunds take five business days [Refund policy].');
  });

  it('refuses ungrounded and empty answers', () => {
    expect(
      finalizeAnswer({ answer: 'The moon is made of cheese.', sources: [refundSource] }).refused,
    ).toBe(true);
    expect(finalizeAnswer({ answer: '', sources: [refundSource] }).refused).toBe(true);
  });

  it('respects a configurable coverage threshold', () => {
    const finalized = finalizeAnswer({
      answer: 'Refunds take five days.',
      sources: [refundSource],
      threshold: 0.95,
    });
    expect(finalized.refused).toBe(true);
    expect(finalized.reason).toBe('ungrounded');
  });
});
