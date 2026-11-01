import { describe, expect, it } from 'vitest';

import { compileAgentLoop, compileTeamTopology, graphToMermaid } from '../src/graph/compile.js';
import { validateGraph } from '../src/graph/v2.js';
import type { AgentDefinition } from '../src/agents/runtime.js';

const agent: AgentDefinition = {
  id: 'a',
  displayName: 'A',
  version: 1,
  profile: 'p',
  job: { role: 'r', inputs: 'i', output: 'o', doneWhen: 'd', domain: 'dom' },
  agentReason: ['own_schedule'],
  tools: [],
  scopes: [],
  maxSteps: 10,
  egressClass: 'internal',
};

describe('agent/team graph compilers (phase 18)', () => {
  it('compiles a bounded agent loop', () => {
    const graph = compileAgentLoop(agent);
    expect(validateGraph(graph)).toEqual([]);
    expect(graph.nodes.find((node) => node.type === 'loop')?.loop?.maxIterations).toBe(10);
  });

  it('compiles team topologies to valid graphs', () => {
    const fanout = compileTeamTopology('fanout', [
      { id: 'a', workflowId: 'agent.a' },
      { id: 'b', workflowId: 'agent.b' },
    ]);
    expect(fanout.nodes.some((node) => node.type === 'parallel')).toBe(true);
    expect(validateGraph(fanout)).toEqual([]);
    const pipeline = compileTeamTopology('pipeline', [
      { id: 'a', workflowId: 'agent.a' },
      { id: 'b', workflowId: 'agent.b' },
    ]);
    expect(pipeline.edges.find((edge) => edge.from === 'a')?.to).toBe('b');
  });

  it('exports Mermaid and highlights the taken path', () => {
    const graph = compileTeamTopology('pipeline', [{ id: 'a', workflowId: 'agent.a' }]);
    const mermaid = graphToMermaid(graph, ['a->end']);
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('a ==>|next| end');
  });
});
