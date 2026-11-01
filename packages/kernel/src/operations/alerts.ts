/** Alert rule evaluation (Phase 18.4): deterministic thresholds, no side effects. */
export interface AlertInput {
  errorRate?: number;
  budgetBurn?: number;
  queueDepth?: number;
  stuckApprovals?: number;
  watchdogInterventions?: number;
  egressDenials?: number;
  drift?: boolean;
}

export interface Alert {
  id: string;
  severity: 'warning' | 'critical';
  message: string;
  value: number | boolean;
  threshold: number;
}

export interface AlertThresholds {
  errorRate?: number;
  budgetBurn?: number;
  queueDepth?: number;
  stuckApprovals?: number;
  watchdogInterventions?: number;
  egressDenials?: number;
}

export const DEFAULT_ALERT_THRESHOLDS: Required<AlertThresholds> = {
  errorRate: 0.05,
  budgetBurn: 0.9,
  queueDepth: 100,
  stuckApprovals: 1,
  watchdogInterventions: 1,
  egressDenials: 1,
};

export function evaluateAlerts(input: AlertInput, thresholds: AlertThresholds = {}): Alert[] {
  const limits = { ...DEFAULT_ALERT_THRESHOLDS, ...thresholds };
  const alerts: Alert[] = [];
  if (input.errorRate !== undefined && input.errorRate > limits.errorRate) {
    alerts.push({
      id: 'error_rate',
      severity: 'critical',
      message: `error rate ${(input.errorRate * 100).toFixed(1)}% over threshold`,
      value: input.errorRate,
      threshold: limits.errorRate,
    });
  }
  if (input.budgetBurn !== undefined && input.budgetBurn >= limits.budgetBurn) {
    alerts.push({
      id: 'budget_burn',
      severity: 'critical',
      message: `budget burn ${(input.budgetBurn * 100).toFixed(0)}%`,
      value: input.budgetBurn,
      threshold: limits.budgetBurn,
    });
  }
  if (input.queueDepth !== undefined && input.queueDepth > limits.queueDepth) {
    alerts.push({
      id: 'queue_depth',
      severity: 'warning',
      message: `queue depth ${input.queueDepth}`,
      value: input.queueDepth,
      threshold: limits.queueDepth,
    });
  }
  if (input.stuckApprovals !== undefined && input.stuckApprovals >= limits.stuckApprovals) {
    alerts.push({
      id: 'stuck_approvals',
      severity: 'warning',
      message: `${input.stuckApprovals} approval(s) waiting`,
      value: input.stuckApprovals,
      threshold: limits.stuckApprovals,
    });
  }
  if (
    input.watchdogInterventions !== undefined &&
    input.watchdogInterventions >= limits.watchdogInterventions
  ) {
    alerts.push({
      id: 'watchdog',
      severity: 'warning',
      message: `${input.watchdogInterventions} watchdog intervention(s)`,
      value: input.watchdogInterventions,
      threshold: limits.watchdogInterventions,
    });
  }
  if (input.egressDenials !== undefined && input.egressDenials >= limits.egressDenials) {
    alerts.push({
      id: 'egress_denied',
      severity: 'critical',
      message: `${input.egressDenials} egress denial(s)`,
      value: input.egressDenials,
      threshold: limits.egressDenials,
    });
  }
  if (input.drift) {
    alerts.push({
      id: 'drift',
      severity: 'warning',
      message: 'quality drift detected',
      value: true,
      threshold: 0,
    });
  }
  return alerts;
}
