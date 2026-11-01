import { describe, expect, it } from 'vitest';

import { compileV1, validateGraph, type WorkflowGraph } from '../src/graph/v2.js';

const base: WorkflowGraph = {
  id: 'g',
  version: '1',
  module: 'm',
  trigger: { type: 'endpoint' },
  start: 'a',
  nodes: [
    { id: 'a', type: 'stage', kind: 'x' },
    { id: 'end', type: 'end', end: 'succeeded' },
  ],
  edges: [{ from: 'a', to: 'end', label: 'next' }],
  defaultErrorEdge: { to: 'end' },
  budget: { maxSteps: 10, maxDurationMs: 1000 },
};

describe('workflow graph v2 validation (phase 18)', () => {
  it('accepts a simple valid graph', () => {
    expect(validateGraph(base)).toEqual([]);
  });

  it('rejects unreachable nodes, missing defaults and unbounded loops', () => {
    expect(
      validateGraph({
        ...base,
        nodes: [...base.nodes, { id: 'orphan', type: 'stage', kind: 'x' }],
      }),
    ).toContain('node orphan is unreachable');
    expect(
      validateGraph({
        ...base,
        nodes: [
          { id: 'a', type: 'branch' },
          { id: 'end', type: 'end', end: 'succeeded' },
        ],
      }),
    ).toContain('branch a needs a default edge');
    expect(
      validateGraph({
        ...base,
        nodes: [
          { id: 'a', type: 'loop' },
          { id: 'end', type: 'end', end: 'succeeded' },
        ],
      }),
    ).toContain('loop a needs maxIterations');
  });

  it('compiles a v1 stage list into a linear graph', () => {
    const graph = compileV1({
      id: 'w',
      version: '1',
      module: 'm',
      stages: [
        { id: 'one', kind: 'a' },
        { id: 'two', kind: 'b' },
      ],
    });
    expect(validateGraph(graph)).toEqual([]);
    expect(graph.edges.map((edge) => `${edge.from}->${edge.to}`)).toEqual([
      'input->one',
      'one->two',
      'two->end',
    ]);
  });
});
