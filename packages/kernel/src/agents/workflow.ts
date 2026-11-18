/**
 * Production agent/team wiring (Phase 16.T1 / 17.T1): `agent.run` is a declared
 * graph (compileAgentLoop) whose `agent_step` node executes one bounded step
 * and checkpoints it; teams compile to subworkflow graphs.
 */
import { z } from 'zod';

import { ApprovalStore } from '../approvals.js';
import { loadApprovalPolicy } from '../approvals/policy.js';
import { AppError } from '../errors.js';
import { compileAgentLoop, compileTeamTopology } from '../graph/compile.js';
import type { WorkflowGraph } from '../graph/v2.js';
import { MAX_TEAM_AGENTS } from '../operations/teams.js';
import { SharedStateStore } from '../state/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ChatModel, Database, KernelLogger } from '../types.js';
import type { WorkflowEngine } from '../workflow.js';
import { AgentCheckpointStore, AgentDefinitionSchema, runAgentStep } from './runtime.js';
import type { AgentState } from './runtime.js';

export const AgentSkillSchema = z
  .object({
    name: z.string().min(1).max(80),
    version: z.number().int().positive(),
    content: z.string().min(1).max(20_000),
    description: z.string().min(1).max(400).optional(),
  })
  .strict();

export const AgentRunInputSchema = z
  .object({
    definition: AgentDefinitionSchema,
    goal: z.string().min(1).max(4000),
    workspaceId: z.string().min(1).max(120).optional(),
    agentId: z.string().min(1).max(80).optional(),
    skills: z.array(AgentSkillSchema).max(20).optional(),
  })
  .strict();
export type AgentRunInput = z.infer<typeof AgentRunInputSchema>;

/** Envelope for the single registered graph; per-run maxSteps is enforced by
 * the step handler because one workflow id cannot carry a graph per agent. */
const AGENT_GRAPH_ENVELOPE = AgentDefinitionSchema.parse({
  id: 'agent',
  displayName: 'Agent',
  version: 1,
  profile: 'Bounded agent loop.',
  job: {
    role: 'run a bounded agent loop',
    inputs: 'goal and definition',
    output: 'final answer or handoff',
    doneWhen: 'the agent decides done, fails or asks a human',
    domain: 'agent runtime',
  },
  agentReason: ['own_schedule'],
  tools: [],
  scopes: [],
  maxSteps: 50,
  egressClass: 'internal',
});

export interface AgentWorkflowDeps {
  database: Database;
  tools: ToolRegistry;
  /** Resolved lazily: a generation may boot before a model is configured. */
  chatModel: () => ChatModel | undefined;
  logger?: KernelLogger;
  /** Human-readable per-run mirror root (`agents/<id>/<runId>/…`). */
  workspaceRoot?: string;
  /** Test/ops seam; defaults to the kernel-owned `agent.paused` state key. */
  isPaused?: (agentId: string) => Promise<boolean>;
}

async function paused(database: Database, agentId: string): Promise<boolean> {
  const entry = await new SharedStateStore(database).get('agent', agentId, 'paused');
  return Boolean((entry?.value as { paused?: unknown } | null)?.paused);
}

/** Register `agent.run` + the `agent_step` handler on one engine generation. */
export function registerAgentWorkflow(engine: WorkflowEngine, deps: AgentWorkflowDeps): void {
  engine.registerStageHandler('agent_step', {
    execute: async (stage) => {
      const input = AgentRunInputSchema.parse(stage.input);
      const agentId = input.agentId ?? input.definition.id;
      const store = new AgentCheckpointStore(stage.database);
      if (await (deps.isPaused ?? ((id) => paused(stage.database, id)))(agentId)) {
        const restored = await store.load(stage.runId);
        const state: AgentState = restored?.state ?? {
          goal: input.goal,
          step: 0,
          status: 'running',
          notes: [],
        };
        if (state.status === 'running') {
          state.status = 'paused';
          await store.saveState(stage.runId, state);
        }
        return {
          output: { decision: 'ask_human', paused: true, step: state.step, state },
          evidence: { paused: true, agentId, step: state.step },
          deterministic: { paused: true, agentId },
        };
      }
      const restored = await store.load(stage.runId);
      if (restored?.state.status === 'paused') {
        restored.state.status = 'running';
        await store.saveState(stage.runId, restored.state);
      }
      const chatModel = deps.chatModel();
      if (!chatModel) {
        throw new AppError(
          'agent.MODEL_UNAVAILABLE',
          'no chat model is configured for agent runs',
          undefined,
          503,
          { category: 'dependency_unavailable', retryable: true },
        );
      }
      const result = await runAgentStep({
        runId: stage.runId,
        definition: input.definition,
        goal: input.goal,
        chatModel,
        tools: deps.tools,
        store,
        ...(deps.logger ? { logger: deps.logger } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        agentId,
        ...(input.skills ? { skills: input.skills } : {}),
        approvals: new ApprovalStore(stage.database),
        policy: await loadApprovalPolicy(stage.database),
        contextSources: { database: stage.database },
        ...(deps.workspaceRoot ? { workspaceRoot: deps.workspaceRoot } : {}),
      });
      return {
        output: {
          decision: result.decision.decision,
          step: result.step,
          state: result.state,
          contextPackHash: result.context?.hash ?? null,
        },
        evidence: {
          step: result.step,
          decision: result.decision.decision,
          reason: result.decision.reason,
          agentId,
          context: result.context
            ? {
                hash: result.context.hash,
                needs: result.context.needs,
                needReason: result.context.needReason,
                tokens: result.context.tokens,
                included: result.context.included.length,
                used: result.context.included.filter((item) => item.used).length,
                pointers: result.context.pointers.length,
                compactionRecommended: result.context.compactionRecommended,
              }
            : null,
        },
        deterministic: {
          step: result.step,
          definitionId: input.definition.id,
          maxSteps: input.definition.maxSteps,
        },
      };
    },
  });

  engine.register(
    {
      id: 'agent.run',
      version: '1',
      module: 'kernel',
      trigger: { type: 'endpoint' },
      stages: [],
      graph: compileAgentLoop(AGENT_GRAPH_ENVELOPE),
    },
    'kernel',
    '1.0.0',
  );
}

export const TeamAgentSchema = z
  .object({
    id: z.string().min(1).max(80),
    definition: AgentDefinitionSchema,
    goal: z.string().min(1).max(4000),
    workspaceId: z.string().min(1).max(120).optional(),
    /** Test seam / specialised agent workflow; defaults to `agent.run`. */
    workflowId: z.string().min(1).max(120).optional(),
  })
  .strict();
export type TeamAgent = z.infer<typeof TeamAgentSchema>;

export const TeamRunInputSchema = z
  .object({
    teamId: z
      .string()
      .min(1)
      .max(60)
      .regex(/^[a-zA-Z0-9_-]+$/),
    topology: z.enum(['pipeline', 'supervisor', 'reviewer', 'fanout']),
    agents: z.array(TeamAgentSchema).min(1).max(MAX_TEAM_AGENTS),
    workspaceId: z.string().min(1).max(120).optional(),
  })
  .strict();
export type TeamRunInput = z.infer<typeof TeamRunInputSchema>;

export interface PreparedTeamRun {
  workflowId: string;
  workflowInput: Record<string, unknown>;
  graph: WorkflowGraph;
}

/**
 * Compile a team's topology into subworkflow nodes. Agent ids become stable
 * `agent-<n>` node ids so arbitrary display ids cannot break the graph grammar.
 */
export function prepareTeamRun(raw: TeamRunInput): PreparedTeamRun {
  const input = TeamRunInputSchema.parse(raw);
  if (input.agents.length > MAX_TEAM_AGENTS) {
    throw new AppError(
      'team.AGENT_CAP',
      `a team holds at most ${MAX_TEAM_AGENTS} agents`,
      undefined,
      400,
    );
  }
  const nodes = input.agents.map((agent, index) => {
    const nodeId = `agent-${index + 1}`;
    const workflowId = agent.workflowId ?? 'agent.run';
    return {
      id: nodeId,
      workflowId,
      ...(workflowId === 'agent.run'
        ? {
            input: {
              definition: `$.input.agents.${nodeId}.definition`,
              goal: `$.input.agents.${nodeId}.goal`,
              agentId: `$.input.agents.${nodeId}.id`,
              ...(input.workspaceId ? { workspaceId: '$.input.workspaceId' } : {}),
            },
          }
        : { input: { goal: `$.input.agents.${nodeId}.goal` } }),
    };
  });
  const graph = compileTeamTopology(input.topology, nodes);
  graph.id = `team.${input.teamId}`;
  return {
    workflowId: graph.id,
    workflowInput: {
      teamId: input.teamId,
      topology: input.topology,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      agents: Object.fromEntries(nodes.map((node, index) => [node.id, input.agents[index]])),
    },
    graph,
  };
}

/** Register the team's graph under `team.<teamId>` and return its run input. */
export function registerTeamWorkflow(engine: WorkflowEngine, input: TeamRunInput): PreparedTeamRun {
  const prepared = prepareTeamRun(input);
  engine.register(
    {
      id: prepared.workflowId,
      version: '1',
      module: 'kernel',
      trigger: { type: 'endpoint' },
      stages: [],
      graph: prepared.graph,
    },
    'kernel',
    '1.0.0',
  );
  return prepared;
}
