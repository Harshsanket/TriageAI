import { describe, expect, it } from 'vitest';

import { evaluateAlerts } from '../src/operations/alerts.js';

describe('alert rules (phase 18.4)', () => {
  it('returns no alerts for a healthy window', () => {
    expect(evaluateAlerts({ errorRate: 0.01, budgetBurn: 0.2, queueDepth: 2 })).toEqual([]);
  });

  it('flags error rate, budget, queue, approvals, watchdog, egress and drift', () => {
    const alerts = evaluateAlerts({
      errorRate: 0.2,
      budgetBurn: 0.95,
      queueDepth: 250,
      stuckApprovals: 2,
      watchdogInterventions: 1,
      egressDenials: 3,
      drift: true,
    }).map((alert) => alert.id);
    expect(alerts).toEqual(
      expect.arrayContaining([
        'error_rate',
        'budget_burn',
        'queue_depth',
        'stuck_approvals',
        'watchdog',
        'egress_denied',
        'drift',
      ]),
    );
  });
});
