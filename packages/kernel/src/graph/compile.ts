/** Compile agent loops, teams and v1 workflows to v2 graphs; Mermaid export. */
import type { AgentDefinition } from '../agents/runtime.js';
import type { TeamTopology } from '../operations/teams.js';
import type { GraphEdge, GraphNode, WorkflowGraph } from './v2.js';

export function compileAgentLoop(definition: AgentDefinition): WorkflowGraph {
  const loopNode: GraphNode = {
    id: 'loop',
    type: 'loop',
    loop: { maxIterations: definition.maxSteps, while: 'true' },
  };
  const stepNode: GraphNode = {
    id: 'step',
    type: 'agent_step',
    labels: ['continue', 'call_tool', 'ask_human', 'handoff', 'done', 'fail'],
  };
  return {
    id: 'agent.run',
    version: String(definition.version),
    module: 'kernel',
    trigger: { type: 'endpoint' },
    start: stepNode.id,
    nodes: [
      stepNode,
      loopNode,
      { id: 'done', type: 'end', end: 'succeeded' },
      { id: 'failed', type: 'end', end: 'failed' },
    ],
    edges: [
      { from: 'step', to: 'loop', label: 'continue' },
      { from: 'step', to: 'done', label: 'done' },
      { from: 'step', to: 'failed', label: 'fail' },
      { from: 'loop', to: 'step', label: 'again' },
    ],
    defaultErrorEdge: { to: 'failed' },
    budget: { maxSteps: definition.maxSteps, maxDurationMs: 900_000 },
    executionStyleReason: 'bounded agent loop for multi-step work with tools',
  };
}

export function compileTeamTopology(
  topology: TeamTopology,
  agents: Array<{ id: string; workflowId: string }>,
): WorkflowGraph {
  const nodes: GraphNode[] = agents.map((agent) => ({
    id: agent.id,
    type: 'subworkflow',
    workflow: { id: agent.workflowId, versionRange: '^1.0.0', wait: true },
  }));
  const edges: GraphEdge[] = [];
  if (topology === 'fanout') {
    nodes.unshift({ id: 'parallel', type: 'parallel', config: { maxParallel: 4 } });
    nodes.push({ id: 'join', type: 'join', join: { mode: 'all', branchTimeoutMs: 120_000 } });
    for (const agent of agents) {
      edges.push({ from: 'parallel', to: agent.id, label: 'branch' });
      edges.push({ from: agent.id, to: 'join', label: 'next' });
    }
    edges.push({ from: 'join', to: 'end', label: 'next' });
  } else {
    for (let index = 0; index < agents.length - 1; index += 1) {
      edges.push({ from: agents[index]!.id, to: agents[index + 1]!.id, label: 'handoff' });
    }
    edges.push({ from: agents.at(-1)?.id ?? 'end', to: 'end', label: 'next' });
  }
  nodes.push({ id: 'end', type: 'end', end: 'succeeded' });
  return {
    id: `team.${topology}`,
    version: '1',
    module: 'kernel',
    trigger: { type: 'endpoint' },
    start: topology === 'fanout' ? 'parallel' : (agents[0]?.id ?? 'end'),
    nodes,
    edges,
    defaultErrorEdge: { to: 'end' },
    budget: { maxSteps: agents.length * 10 + 10, maxDurationMs: 900_000 },
    executionStyleReason: `team topology ${topology}`,
  };
}

export function graphToMermaid(graph: WorkflowGraph, takenPath: string[] = []): string {
  const lines = ['flowchart TD'];
  for (const node of graph.nodes) {
    const shape =
      node.type === 'end'
        ? `([${node.end ?? 'end'}])`
        : node.type === 'llm_decision' || node.type === 'branch'
          ? `{${node.id}}`
          : `[${node.id}]`;
    lines.push(`  ${node.id}${shape}`);
  }
  const taken = new Set(takenPath);
  for (const edge of graph.edges) {
    const style = taken.has(`${edge.from}->${edge.to}`) ? ' ==>' : ' -->';
    lines.push(`  ${edge.from}${style}|${edge.label}| ${edge.to}`);
  }
  return lines.join('\n');
}
