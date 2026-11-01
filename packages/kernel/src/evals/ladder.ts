/** Execution-style ladder (Phase 18.3/18.T23). */
export type ExecutionRung = 1 | 2 | 3 | 4 | 5;

export function validateExecutionStyle(args: {
  rung: ExecutionRung;
  executionStyleReason?: string;
  hasUnboundedLoop?: boolean;
}): string[] {
  const problems: string[] = [];
  if (args.rung >= 3 && !args.executionStyleReason?.trim()) {
    problems.push('rung 3+ needs an executionStyleReason');
  }
  if (args.rung >= 4 && args.hasUnboundedLoop) problems.push('agent loops need maxIterations');
  return problems;
}

/** Suggest converting an agent flow to a pipeline when its path is stable. */
export function suggestPipeline(
  paths: string[][],
  threshold = 0.95,
): { suggest: boolean; path?: string[]; share: number } {
  if (paths.length === 0) return { suggest: false, share: 0 };
  const counts = new Map<string, { path: string[]; count: number }>();
  for (const path of paths) {
    const key = path.join(' → ');
    const entry = counts.get(key) ?? { path, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0]!;
  const share = best.count / paths.length;
  return share >= threshold ? { suggest: true, path: best.path, share } : { suggest: false, share };
}
