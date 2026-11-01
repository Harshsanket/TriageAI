/** Minimal checkpointed agent loop (Phase 16.T1 core). Decisions are structured
 * model outputs; only registered tools execute; every step is persisted. */
import { ulid } from 'ulid';
import { z } from 'zod';

import { AppError } from '../errors.js';
import { callModel, type CallModelDeps } from '../models/callModel.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { Database, KernelLogger } from '../types.js';

export const AgentDefinitionSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1).max(40),
    /** Stable categorical colour used by every surface that draws the agent. */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    version: z.number().int().positive().default(1),
    profile: z.string().min(1).max(2000),
    job: z
      .object({
        role: z.string().min(1),
        inputs: z.string().min(1),
        output: z.string().min(1),
        doneWhen: z.string().min(1),
        domain: z.string().min(1),
      })
      .strict(),
    agentReason: z.array(z.string()).min(1),
    tools: z.array(z.string()).default([]),
    scopes: z.array(z.string()).default([]),
    maxSteps: z.number().int().positive().max(50).default(10),
    egressClass: z.enum(['public', 'internal', 'restricted', 'secret']).default('internal'),
  })
  .strict();
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export interface AgentDecision {
  decision: 'call_tool' | 'done' | 'ask_human' | 'fail';
  reason: string;
  tool?: string;
  args?: unknown;
  answer?: string;
}

const DecisionSchema = z
  .object({
    decision: z.enum(['call_tool', 'done', 'ask_human', 'fail']),
    reason: z.string().max(500),
    tool: z.string().optional(),
    args: z.unknown().optional(),
    answer: z.string().optional(),
  })
  .strict();

export interface AgentState {
  goal: string;
  step: number;
  status: 'running' | 'done' | 'failed' | 'awaiting_human';
  answer?: string;
  notes: string[];
}

export class AgentCheckpointStore {
  constructor(private readonly database: Database) {}

  async load(runId: string): Promise<{ state: AgentState; decisions: AgentDecision[] } | null> {
    const checkpoints = await this.database.query<{ state: AgentState }>(
      `SELECT state FROM agent_checkpoints WHERE run_id = $1`,
      [runId],
    );
    if (!checkpoints[0]) return null;
    const steps = await this.database.query<{ payload: AgentDecision }>(
      `SELECT payload FROM agent_steps WHERE run_id = $1 ORDER BY step_no`,
      [runId],
    );
    return { state: checkpoints[0].state, decisions: steps.map((step) => step.payload) };
  }

  async saveStep(
    runId: string,
    step: number,
    decision: AgentDecision,
    state: AgentState,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO agent_steps (id, run_id, step_no, decision, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (run_id, step_no) DO UPDATE SET decision = EXCLUDED.decision, payload = EXCLUDED.payload`,
      [ulid(), runId, step, decision.decision, decision],
    );
    await this.database.query(
      `INSERT INTO agent_checkpoints (run_id, state, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (run_id) DO UPDATE SET state = EXCLUDED.state, version = agent_checkpoints.version + 1, updated_at = now()`,
      [runId, state],
    );
  }
}

export interface RunAgentOptions {
  runId: string;
  definition: AgentDefinition;
  goal: string;
  chatModel: CallModelDeps['chatModel'];
  tools: ToolRegistry;
  store: AgentCheckpointStore;
  logger?: KernelLogger;
  workspaceId?: string;
  agentId?: string;
  /** Enabled, in-scope skills; the caller owns selection and storage. */
  skills?: Array<{ name: string; version: number; content: string }>;
}

export async function runAgent(options: RunAgentOptions): Promise<{
  state: AgentState;
  steps: number;
  resumed: boolean;
}> {
  const parsed = AgentDefinitionSchema.parse(options.definition);
  const restored = await options.store.load(options.runId);
  const state: AgentState = restored?.state ?? {
    goal: options.goal,
    step: 0,
    status: 'running',
    notes: [],
  };
  const decisions = restored?.decisions ?? [];
  const resumed = restored !== null;
  const toolIndex = parsed.tools.join(', ') || 'none';
  const skillText =
    options.skills && options.skills.length > 0
      ? `\nSkills (instructions, never executable):\n${options.skills
          .map((skill) => `[${skill.name} v${skill.version}]\n${skill.content}`)
          .join('\n')}`
      : '';
  const context: ToolContext = {
    runId: options.runId,
    stepId: 'agent',
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    grantedScopes: parsed.scopes,
    egressClass: parsed.egressClass,
    hosted: options.chatModel.describe().hosted,
    org: { ownsEmail: () => false },
    logger: options.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  while (state.step < parsed.maxSteps && state.status === 'running') {
    const index = state.step;
    let decision = decisions[index];
    if (!decision) {
      const result = await callModel(
        { chatModel: options.chatModel, logger: options.logger },
        {
          id: 'agent.step',
          promptTemplateId: 'agent.step',
          promptVersion: '1',
          outputSchema: DecisionSchema,
          maxOutputTokens: 512,
          timeoutMs: 30_000,
          requiredFields: [],
        },
        {
          runId: options.runId,
          workflowId: 'agent.run',
          stepName: `step-${index}`,
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
          ...(options.agentId ? { agentId: options.agentId } : {}),
          ...(options.skills && options.skills.length > 0
            ? { skills: options.skills.map(({ name, version }) => ({ name, version })) }
            : {}),
        },
        {
          messages: [
            {
              role: 'system',
              content: `You are ${parsed.displayName}. ${parsed.profile}\nJob: ${parsed.job.role}. Done when: ${parsed.job.doneWhen}.\nTools: ${toolIndex}.${skillText}\nReturn JSON {decision,tool?,args?,reason,answer?}.`,
            },
            ...(state.notes.length > 0
              ? [{ role: 'assistant' as const, content: state.notes.join('\n') }]
              : []),
            { role: 'user', content: `Goal: ${state.goal}` },
          ],
          structured: true,
          temperature: 0,
        },
      );
      decision = result.parsed as AgentDecision;
      if (!decision || !['call_tool', 'done', 'ask_human', 'fail'].includes(decision.decision)) {
        throw new AppError(
          'agent.DECISION_INVALID',
          'agent returned an invalid decision',
          undefined,
          502,
        );
      }
    }

    if (decision.decision === 'call_tool') {
      const toolName = decision.tool ?? '';
      const invoked = await options.tools.invoke(toolName, decision.args ?? {}, context, {
        approved: false,
      });
      const observation = invoked.ok
        ? `tool ${toolName} -> ${JSON.stringify(invoked.data).slice(0, 500)}`
        : `tool ${toolName} failed: ${invoked.error.code} (${invoked.error.message.slice(0, 200)})`;
      state.notes.push(observation);
    } else if (decision.decision === 'done') {
      state.status = 'done';
      state.answer = decision.answer ?? decision.reason;
    } else if (decision.decision === 'ask_human') {
      state.status = 'awaiting_human';
    } else {
      state.status = 'failed';
    }
    state.step = index + 1;
    await options.store.saveStep(options.runId, index, decision, state);
    if (state.status !== 'running') break;
    if (!decisions[index]) decisions[index] = decision;
  }
  return { state, steps: state.step, resumed };
}
