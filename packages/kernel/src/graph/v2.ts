/** Workflow graph v2 (Phase 18.3/18.T19): typed nodes, labelled edges, load-time validation. */
import type { ErrorCategory } from '../errors.js';
import { validateWhen } from '../grammar.js';

export type GraphNodeType =
  | 'stage'
  | 'tool'
  | 'llm_decision'
  | 'agent_step'
  | 'branch'
  | 'approval'
  | 'parallel'
  | 'join'
  | 'map'
  | 'loop'
  | 'subworkflow'
  | 'wait'
  | 'end';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  kind?: string;
  tool?: string;
  workflow?: { id: string; versionRange: string; wait: boolean };
  input?: Record<string, unknown>;
  config?: Record<string, unknown>;
  timeoutMs?: number;
  retry?: { attempts: number; backoffMs?: number[]; retryOn?: ErrorCategory[] };
  labels?: string[];
  join?: { mode: 'all' | 'any' | 'n'; n?: number; branchTimeoutMs: number };
  map?: { items: string; maxParallel: number };
  loop?: { maxIterations: number; while: string };
  approval?: { approvers: string[]; expiresAfterMs: number };
  end?: 'succeeded' | 'failed' | 'cancelled' | 'escalated';
  evaluate?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
  when?: string;
  on?: ErrorCategory[];
  compensate?: boolean;
  isDefault?: boolean;
}

export interface WorkflowGraph {
  id: string;
  version: string;
  module: string;
  trigger: {
    type: 'endpoint' | 'manual' | 'event' | 'schedule';
    config?: Record<string, unknown>;
    when?: string;
    schedule?: {
      cron: string;
      probe?: { kind: 'watermark'; read: string };
      overlap: 'skip';
      silentWhenEmpty: true;
    };
  };
  start: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  defaultErrorEdge: { to: string };
  budget: { maxSteps: number; maxDurationMs: number; maxCost?: number };
  executionStyleReason?: string;
}

export function validateGraph(graph: WorkflowGraph): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) problems.push(`duplicate node id ${node.id}`);
    ids.add(node.id);
  }
  if (!ids.has(graph.start)) problems.push(`start node ${graph.start} does not exist`);
  if (!ids.has(graph.defaultErrorEdge.to)) {
    problems.push(`default error edge points at missing node ${graph.defaultErrorEdge.to}`);
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) problems.push(`edge from missing node ${edge.from}`);
    if (!ids.has(edge.to)) problems.push(`edge to missing node ${edge.to}`);
    if (edge.when) {
      try {
        validateWhen(edge.when);
      } catch (err) {
        problems.push(`edge ${edge.from}→${edge.to} guard: ${(err as Error).message}`);
      }
    }
  }
  if (graph.trigger.type === 'event' && !graph.trigger.when?.trim()) {
    problems.push('event triggers need a filter narrower than the event kind');
  }
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  for (const node of graph.nodes) {
    const edges = outgoing.get(node.id) ?? [];
    if (!['end'].includes(node.type) && edges.length === 0) {
      problems.push(`node ${node.id} has no outgoing edge`);
    }
    if (
      (node.type === 'branch' || node.type === 'llm_decision') &&
      !edges.some((edge) => edge.isDefault)
    ) {
      problems.push(`${node.type} ${node.id} needs a default edge`);
    }
    if (node.type === 'loop' && (!node.loop?.maxIterations || node.loop.maxIterations < 1)) {
      problems.push(`loop ${node.id} needs maxIterations`);
    }
    if (
      (node.type === 'map' || node.type === 'parallel') &&
      !node.map?.maxParallel &&
      !node.config?.maxParallel
    ) {
      problems.push(`${node.type} ${node.id} needs a parallelism cap`);
    }
    if (node.type === 'join') {
      const incoming = graph.edges.filter((edge) => edge.to === node.id).length;
      if (node.join?.mode === 'n' && (node.join.n ?? 0) > incoming) {
        problems.push(
          `join ${node.id} expects ${node.join.n} branches but only ${incoming} arrive`,
        );
      }
    }
    if (node.type === 'subworkflow' && !node.workflow)
      problems.push(`subworkflow ${node.id} needs a workflow`);
    if (node.type === 'end' && !node.end) problems.push(`end ${node.id} needs an outcome`);
  }

  // Reachability from start.
  const reachable = new Set<string>();
  const queue = [graph.start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of outgoing.get(current) ?? []) {
      if (!reachable.has(edge.to)) queue.push(edge.to);
    }
  }
  for (const node of graph.nodes) {
    if (!reachable.has(node.id)) problems.push(`node ${node.id} is unreachable`);
  }

  // Every node can reach an end.
  const endIds = new Set(graph.nodes.filter((node) => node.type === 'end').map((node) => node.id));
  const canReachEnd = new Set<string>(endIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (canReachEnd.has(edge.to) && !canReachEnd.has(edge.from)) {
        canReachEnd.add(edge.from);
        changed = true;
      }
    }
  }
  for (const node of graph.nodes) {
    if (!canReachEnd.has(node.id)) problems.push(`node ${node.id} cannot reach an end`);
  }

  if (graph.budget.maxSteps < graph.nodes.length) {
    problems.push('maxSteps is smaller than the graph size');
  }
  return problems;
}

/** v1 stage lists compile to a straight-line graph (18.T19). */
export function compileV1(args: {
  id: string;
  version: string;
  module: string;
  stages: Array<{ id: string; kind: string; when?: string }>;
}): WorkflowGraph {
  const nodes: GraphNode[] = [
    ...args.stages.map((stage) => ({ id: stage.id, type: 'stage' as const, kind: stage.kind })),
    { id: 'end', type: 'end' as const, end: 'succeeded' as const },
  ];
  const edges: GraphEdge[] = args.stages.map((stage, index) => ({
    from: index === 0 ? 'input' : (args.stages[index - 1]?.id as string),
    to: stage.id,
    label: 'next',
    ...(stage.when ? { when: stage.when } : {}),
  }));
  if (args.stages.length > 0) {
    edges.push({ from: args.stages.at(-1)?.id as string, to: 'end', label: 'next' });
  }
  return {
    id: args.id,
    version: args.version,
    module: args.module,
    trigger: { type: 'endpoint' },
    start: 'input',
    nodes: [{ id: 'input', type: 'stage', kind: 'input' }, ...nodes],
    edges,
    defaultErrorEdge: { to: 'end' },
    budget: { maxSteps: Math.max(10, args.stages.length + 2), maxDurationMs: 300_000 },
  };
}
