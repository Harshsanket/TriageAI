/** Trajectory metrics (Phase 18.1/18.T24). */
export interface TrajectoryStep {
  nodeId: string;
  kind: 'stage' | 'tool' | 'llm_decision' | 'agent_step' | 'retrieval' | 'approval';
  tool?: string;
  argsHash?: string;
  used?: boolean;
  error?: string;
}

export interface TrajectoryMetrics {
  steps: number;
  pathEfficiency?: number;
  redundantSteps: number;
  firstFailingNode?: string;
  wastedSteps: number;
}

export function trajectoryMetrics(
  steps: TrajectoryStep[],
  reference?: TrajectoryStep[],
): TrajectoryMetrics {
  const seen = new Set<string>();
  let redundant = 0;
  let wasted = 0;
  for (const step of steps) {
    const key = `${step.kind}:${step.nodeId}:${step.tool ?? ''}:${step.argsHash ?? ''}`;
    if (seen.has(key)) redundant += 1;
    seen.add(key);
    if (step.used === false) wasted += 1;
  }
  return {
    steps: steps.length,
    ...(reference
      ? { pathEfficiency: Number((reference.length / Math.max(1, steps.length)).toFixed(3)) }
      : {}),
    redundantSteps: redundant,
    ...(steps.find((step) => step.error)
      ? { firstFailingNode: steps.find((step) => step.error)?.nodeId }
      : {}),
    wastedSteps: wasted,
  };
}

export function stepPassed(score: number, floor = 0.8): boolean {
  return score >= floor;
}
