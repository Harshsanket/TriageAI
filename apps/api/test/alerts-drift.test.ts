import { describe, expect, it } from 'vitest';

import { detectEvalDrift } from '../src/routes/alerts.js';

describe('eval drift for alerts (phase 18)', () => {
  it('flags a drop against a rolling baseline and skips short series', () => {
    const reports = [
      { metrics: { groundedness: 0.2 } },
      { metrics: { groundedness: 0.85 } },
      { metrics: { groundedness: 0.9 } },
      { metrics: { groundedness: 0.8 } },
    ];
    expect(detectEvalDrift(reports)).toBe(true);
    expect(detectEvalDrift(reports.slice(0, 2))).toBe(false);
    expect(detectEvalDrift([{ metrics: null }])).toBe(false);
  });
});
