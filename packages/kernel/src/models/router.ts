/** Task-based, cost-aware model routing (Phase 19.2, ADR-0035/19). */
export interface ModelOption {
  provider: string;
  model: string;
  tier: 'embeddings' | 'small' | 'large' | 'judge';
  /** Measured quality for the task (0..1), or undefined when unknown. */
  quality?: number;
  /** Estimated cost per 1K output tokens (USD). */
  costPer1k?: number;
  egress: 'local' | 'hosted';
  enabled?: boolean;
}

export interface TaskRoute {
  primary: string;
  fallback?: string;
  qualityFloor: number;
  escalateWhen?: string[];
  maxCostPerCall?: number;
  egressClass?: 'public' | 'internal' | 'restricted' | 'secret';
}

export interface RoutingDecision {
  option: ModelOption | null;
  reason: string;
  alternatives: string[];
}

/**
 * Cheapest option whose measured quality clears the floor; when no option has
 * quality data, use the configured primary. Egress always wins over cost.
 */
export function chooseModel(args: {
  route: TaskRoute;
  options: ModelOption[];
  taskSensitivity?: 'public' | 'internal' | 'restricted' | 'secret';
}): RoutingDecision {
  const available = args.options.filter(
    (option) =>
      option.enabled !== false &&
      (!(args.taskSensitivity === 'restricted' || args.taskSensitivity === 'secret') ||
        option.egress === 'local'),
  );
  if (available.length === 0) {
    return { option: null, reason: 'no_eligible_model', alternatives: [] };
  }
  const primary = available.find(
    (option) => `${option.provider}:${option.model}` === args.route.primary,
  );
  const fallback = available.find(
    (option) => `${option.provider}:${option.model}` === args.route.fallback,
  );
  const measured = available
    .filter((option) => option.quality !== undefined && option.quality >= args.route.qualityFloor)
    .filter(
      (option) =>
        args.route.maxCostPerCall === undefined ||
        (option.costPer1k ?? Number.POSITIVE_INFINITY) <= args.route.maxCostPerCall,
    )
    .sort((a, b) => (a.costPer1k ?? 0) - (b.costPer1k ?? 0));
  if (measured.length > 0) {
    return {
      option: measured[0] ?? null,
      reason: 'cheapest_above_quality_floor',
      alternatives: measured.slice(1).map((option) => `${option.provider}:${option.model}`),
    };
  }
  if (primary) {
    return { option: primary, reason: 'configured_primary', alternatives: [] };
  }
  if (fallback) {
    return { option: fallback, reason: 'configured_fallback', alternatives: [] };
  }
  return {
    option: available[0] ?? null,
    reason: 'any_eligible_model',
    alternatives: available.slice(1).map((option) => `${option.provider}:${option.model}`),
  };
}
