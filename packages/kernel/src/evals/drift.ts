/** Drift detection and opt-in auto-rollback (Phase 18.1). */
export interface RollingBaseline {
  mean: number;
  stddev: number;
  samples: number;
}

export function rollingBaseline(values: number[]): RollingBaseline {
  if (values.length === 0) return { mean: 0, stddev: 0, samples: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance), samples: values.length };
}

export interface DriftResult {
  drift: boolean;
  zScore: number;
  reason: string;
}

export function detectDrift(
  current: number,
  baseline: RollingBaseline,
  options: { zThreshold?: number; absoluteThreshold?: number } = {},
): DriftResult {
  if (baseline.samples < 2) return { drift: false, zScore: 0, reason: 'baseline_insufficient' };
  const z = baseline.stddev === 0 ? 0 : (current - baseline.mean) / baseline.stddev;
  const zThreshold = options.zThreshold ?? 3;
  const absolute = Math.abs(current - baseline.mean);
  if (
    Math.abs(z) >= zThreshold ||
    (options.absoluteThreshold !== undefined && absolute >= options.absoluteThreshold)
  ) {
    return {
      drift: true,
      zScore: Number(z.toFixed(3)),
      reason: Math.abs(z) >= zThreshold ? 'z_score' : 'absolute_threshold',
    };
  }
  return { drift: false, zScore: Number(z.toFixed(3)), reason: 'within_baseline' };
}

/** Auto-rollback only after N consecutive below-floor windows. */
export function shouldAutoRollback(scores: number[], floor: number, windows = 3): boolean {
  if (scores.length < windows) return false;
  return scores.slice(-windows).every((score) => score < floor);
}
