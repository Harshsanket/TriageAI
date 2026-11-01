/** Team topology router (Phase 17.T1): pick the simplest topology that fits. */
export type TeamTopology = 'single' | 'pipeline' | 'supervisor' | 'reviewer' | 'fanout';

export interface TeamTaskShape {
  agentCount: number;
  independentSubtasks: number;
  parallelizable: boolean;
  needsReview: boolean;
  fanOutCap?: number;
}

export interface TeamRouting {
  topology: TeamTopology;
  reason: string;
}

export const MAX_TEAM_AGENTS = 6;

export function chooseTopology(shape: TeamTaskShape): TeamRouting {
  if (shape.agentCount > MAX_TEAM_AGENTS) {
    throw new Error(`a team holds at most ${MAX_TEAM_AGENTS} agents`);
  }
  if (shape.agentCount <= 1) return { topology: 'single', reason: 'one_agent' };
  if (shape.needsReview) return { topology: 'reviewer', reason: 'separate_reviewer' };
  if (shape.independentSubtasks > 1 && shape.parallelizable) {
    return { topology: 'fanout', reason: 'independent_parallel_subtasks' };
  }
  if (shape.independentSubtasks > 1) {
    return { topology: 'supervisor', reason: 'independent_subtasks_need_planning' };
  }
  return { topology: 'pipeline', reason: 'sequential_handoff' };
}
