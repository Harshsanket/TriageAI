/**
 * Host wiring for agent and team runs (Phase 16.T1 / 17.T1/T2/T3).
 *
 * The kernel owns the graph + step handler; this service starts runs, exposes
 * the monitor read model, and turns watchdog findings into audited pauses.
 * It never reads module-owned tables: external agents are surfaced by
 * `modules/public-api`'s own activity route.
 */
import { createHash } from 'node:crypto';

import { ulid } from 'ulid';

import {
  AgentDefinitionSchema,
  AgentRunInputSchema,
  AppError,
  SharedStateStore,
  TeamRunInputSchema,
  invalid,
  listMemories,
  memoryMarkdown,
  notFound,
  recallMemories,
  registerAgentWorkflow,
  registerTeamWorkflow,
  skillMarkdown,
  slugifySkillName,
  validateAgentDefinition,
  watchdogScan,
} from '@triageai/kernel';
import type {
  AgentDefinition,
  AgentWatchEvent,
  Kernel,
  KernelLogger,
  MemoryEntry,
} from '@triageai/kernel';

import { writeAudit } from './audit.js';

export interface AgentRuntimeOptions {
  chatModel: () => import('@triageai/kernel').ChatModel | undefined;
  logger?: KernelLogger;
  workspaceRoot?: string;
  /** Optional embedder for vector memory recall. */
  embedder?: () =>
    { embed(texts: string[]): Promise<{ vectors: number[][]; modelVersion: string }> } | undefined;
}

/** Register the agent graph + step handler on one kernel generation. */
export function registerAgentRuntime(kernel: Kernel, options: AgentRuntimeOptions): void {
  registerAgentWorkflow(kernel.workflowEngine, {
    database: kernel.database,
    tools: kernel.tools,
    chatModel: options.chatModel,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.embedder ? { embedder: options.embedder } : {}),
  });
}

async function enqueueRun(kernel: Kernel, runId: string): Promise<void> {
  await kernel.queue.enqueue('workflow.run', { runId }, { idempotencyKey: `run:${runId}` });
}

export async function startAgentRun(
  kernel: Kernel,
  raw: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<{ runId: string; deduped: boolean }> {
  const input = AgentRunInputSchema.parse(raw);
  const started = await kernel.workflowEngine.start('agent.run', input, {
    trigger: 'endpoint',
    title: `Agent: ${input.definition.displayName}`,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });
  if (!started.deduped) await enqueueRun(kernel, started.runId);
  return started;
}

export async function startTeamRun(
  kernel: Kernel,
  raw: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<{ runId: string; deduped: boolean; workflowId: string }> {
  const input = TeamRunInputSchema.parse(raw);
  const prepared = registerTeamWorkflow(kernel.workflowEngine, input);
  const started = await kernel.workflowEngine.start(prepared.workflowId, prepared.workflowInput, {
    trigger: 'endpoint',
    title: `Team: ${input.teamId} (${input.topology})`,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });
  if (!started.deduped) await enqueueRun(kernel, started.runId);
  return { ...started, workflowId: prepared.workflowId };
}

export async function pauseAgent(
  kernel: Kernel,
  agentId: string,
  actor: string,
  reason: string,
): Promise<{ agentId: string; paused: true; runs: number }> {
  const at = new Date().toISOString();
  const store = new SharedStateStore(kernel.database);
  await store.set({
    scopeType: 'agent',
    scopeId: agentId,
    key: 'paused',
    value: { paused: true, reason, by: actor, at },
    sensitivity: 'internal',
  });
  // The cursor keeps a resume from re-pausing on the same pre-pause steps.
  await store.set({
    scopeType: 'agent',
    scopeId: agentId,
    key: 'watchdog.cursor',
    value: { at },
    sensitivity: 'internal',
  });
  const live = await kernel.database.query<{ id: string }>(
    `SELECT id FROM workflow_runs
     WHERE workflow_id = 'agent.run' AND status IN ('PENDING','RUNNING')
       AND COALESCE(input->>'agentId', input->'definition'->>'id') = $1`,
    [agentId],
  );
  await writeAudit(kernel.database, {
    actor,
    action: 'agent.paused',
    subject: agentId,
    payload: { reason },
  });
  return { agentId, paused: true, runs: live.length };
}

export async function resumeAgent(
  kernel: Kernel,
  agentId: string,
  actor: string,
  reason: string,
): Promise<{ agentId: string; paused: false; resumed: string[] }> {
  const at = new Date().toISOString();
  const store = new SharedStateStore(kernel.database);
  await store.set({
    scopeType: 'agent',
    scopeId: agentId,
    key: 'paused',
    value: { paused: false, reason, by: actor, at },
    sensitivity: 'internal',
  });
  await store.set({
    scopeType: 'agent',
    scopeId: agentId,
    key: 'watchdog.cursor',
    value: { at },
    sensitivity: 'internal',
  });
  // Paused runs end on the declared `ask_human` edge (AWAITING). Re-open them
  // at the next unexecuted step: the checkpoint is the resume point.
  const parked = await kernel.database.query<{ id: string }>(
    `SELECT id FROM workflow_runs
     WHERE workflow_id = 'agent.run' AND status = 'AWAITING'
       AND COALESCE(input->>'agentId', input->'definition'->>'id') = $1`,
    [agentId],
  );
  const resumed: string[] = [];
  for (const run of parked) {
    const updated = await kernel.database.query<{ id: string }>(
      `UPDATE workflow_runs SET status = 'PENDING', finished_at = NULL
       WHERE id = $1 AND status = 'AWAITING' RETURNING id`,
      [run.id],
    );
    if (!updated[0]) continue;
    await kernel.database.query(
      `UPDATE agent_checkpoints
       SET state = jsonb_set(state, '{status}', '"running"'), updated_at = now()
       WHERE run_id = $1 AND state->>'status' IN ('paused','awaiting_human')`,
      [run.id],
    );
    await enqueueRun(kernel, run.id);
    resumed.push(run.id);
  }
  await writeAudit(kernel.database, {
    actor,
    action: 'agent.resumed',
    subject: agentId,
    payload: { reason, runs: resumed },
  });
  return { agentId, paused: false, resumed };
}

interface AgentRunRow {
  [key: string]: unknown;
  id: string;
  status: string;
  input: Record<string, unknown> | null;
  created_at: Date | string;
  finished_at: Date | string | null;
  error: string | null;
}

interface AgentDefinitionRow {
  [key: string]: unknown;
  definition: AgentDefinition;
  updated_at: Date | string;
}

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

function agentIdOf(row: AgentRunRow): string | null {
  const input = row.input ?? {};
  const explicit = typeof input.agentId === 'string' ? input.agentId : null;
  if (explicit) return explicit;
  const definition = input.definition as { id?: unknown } | undefined;
  return typeof definition?.id === 'string' ? definition.id : null;
}

export interface AgentMonitorRow {
  id: string;
  displayName: string;
  color?: string;
  status: 'running' | 'off' | 'degraded' | 'paused';
  paused: boolean;
  runs: number;
  latestRun: {
    id: string;
    status: string;
    createdAt: string | null;
    finishedAt: string | null;
    error: string | null;
  } | null;
}

/** A content-only agent profile imported by a pack; never executable. */
export interface PackAgentProfile {
  id: string;
  name: string;
  packId: string;
  importedAt: string;
  body: string;
  source: 'pack';
  readOnly: true;
}

export async function listAgents(kernel: Kernel): Promise<{
  agents: AgentMonitorRow[];
  teams: Array<{
    runId: string;
    teamId: string | null;
    topology: string | null;
    status: string;
    agents: number;
    createdAt: string | null;
  }>;
  packProfiles: PackAgentProfile[];
}> {
  const definitions = await kernel.database
    .query<AgentDefinitionRow>(`SELECT definition, updated_at FROM agent_definitions`)
    .catch(() => [] as AgentDefinitionRow[]);
  const runs = await kernel.database.query<AgentRunRow>(
    `SELECT id, status, input, created_at, finished_at, error FROM workflow_runs
     WHERE workflow_id = 'agent.run' ORDER BY created_at DESC LIMIT 200`,
  );
  const pausedRows = await kernel.database.query<{ scope_id: string; value: unknown }>(
    `SELECT scope_id, value FROM shared_state WHERE scope_type = 'agent' AND key = 'paused'`,
  );
  const failed = await kernel.database.query<{ run_id: string }>(
    `SELECT DISTINCT run_id FROM agent_steps
     WHERE decision = 'fail' AND at > now() - interval '24 hours'`,
  );
  const teamRuns = await kernel.database.query<AgentRunRow>(
    `SELECT id, status, input, created_at, finished_at, error FROM workflow_runs
     WHERE workflow_id LIKE 'team.%' ORDER BY created_at DESC LIMIT 50`,
  );
  // Pack profiles are content-only settings records; reading them does not
  // touch the pack installer's files and they are marked read-only below.
  const profileRows = await kernel.database
    .query<{ value: { profiles?: unknown } }>(
      `SELECT value FROM settings WHERE key = 'plugins.agentProfiles'`,
    )
    .catch(() => [] as Array<{ value: { profiles?: unknown } }>);
  const rawProfiles = Array.isArray(profileRows[0]?.value?.profiles)
    ? (profileRows[0]?.value?.profiles as Array<Record<string, unknown>>)
    : [];
  const packProfiles: PackAgentProfile[] = rawProfiles.flatMap((profile) => {
    const name = typeof profile.name === 'string' ? profile.name : null;
    const packId = typeof profile.packId === 'string' ? profile.packId : null;
    if (!name || !packId) return [];
    return [
      {
        id: `pack:${packId}:${name}`,
        name,
        packId,
        importedAt:
          typeof profile.importedAt === 'string' ? profile.importedAt : new Date(0).toISOString(),
        body: typeof profile.body === 'string' ? profile.body : '',
        source: 'pack' as const,
        readOnly: true as const,
      },
    ];
  });

  const agents = new Map<string, AgentMonitorRow>();
  for (const row of definitions) {
    const definition = AgentDefinitionSchema.parse(row.definition);
    agents.set(definition.id, {
      id: definition.id,
      displayName: definition.displayName,
      ...(definition.color ? { color: definition.color } : {}),
      status: 'off',
      paused: false,
      runs: 0,
      latestRun: null,
    });
  }
  const failedRunIds = new Set(failed.map((row) => row.run_id));
  for (const run of runs) {
    const agentId = agentIdOf(run);
    if (!agentId) continue;
    const definition = (run.input?.definition ?? null) as AgentDefinition | null;
    const existing = agents.get(agentId) ?? {
      id: agentId,
      displayName: definition?.displayName ?? agentId,
      ...(definition?.color ? { color: definition.color } : {}),
      status: 'off' as const,
      paused: false,
      runs: 0,
      latestRun: null,
    };
    existing.runs += 1;
    if (!existing.latestRun) {
      existing.latestRun = {
        id: run.id,
        status: run.status,
        createdAt: iso(run.created_at),
        finishedAt: iso(run.finished_at),
        error: run.error,
      };
    }
    if (run.status === 'PENDING' || run.status === 'RUNNING') existing.status = 'running';
    else if (
      existing.status !== 'running' &&
      (run.status === 'FAILED' || failedRunIds.has(run.id))
    ) {
      existing.status = 'degraded';
    }
    agents.set(agentId, existing);
  }
  for (const row of pausedRows) {
    const value = row.value as { paused?: unknown } | null;
    if (value?.paused !== true) continue;
    const existing = agents.get(row.scope_id) ?? {
      id: row.scope_id,
      displayName: row.scope_id,
      status: 'paused' as const,
      paused: true,
      runs: 0,
      latestRun: null,
    };
    existing.paused = true;
    existing.status = 'paused';
    agents.set(row.scope_id, existing);
  }

  return {
    agents: [...agents.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    teams: teamRuns.map((run) => {
      const input = run.input ?? {};
      const agentMap = input.agents as Record<string, unknown> | undefined;
      return {
        runId: run.id,
        teamId: typeof input.teamId === 'string' ? input.teamId : null,
        topology: typeof input.topology === 'string' ? input.topology : null,
        status: run.status,
        agents: agentMap ? Object.keys(agentMap).length : 0,
        createdAt: iso(run.created_at),
      };
    }),
    packProfiles,
  };
}

/** A memory row as the `/agents` viewer consumes it (no new route). */
export interface AgentMemoryEntry {
  id: string;
  scope: string;
  scopeId: string;
  kind: string;
  text: string;
  sourceRefs: string[];
  confidence: number;
  status: string;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  derivedFromUntrusted: boolean;
  sensitivity: string;
}

export interface AgentMemory {
  entries: AgentMemoryEntry[];
  /** Active + proposed entries in scope, before a viewer search narrows them. */
  total: number;
  /** Active entries only, masked and deterministically ordered. */
  markdown: string;
}

function memoryView(entry: MemoryEntry): AgentMemoryEntry {
  return {
    id: entry.id,
    scope: entry.scope,
    scopeId: entry.scopeId,
    kind: entry.kind,
    text: entry.text,
    sourceRefs: entry.sourceRefs,
    confidence: entry.confidence,
    status: entry.status,
    useCount: entry.useCount,
    lastUsedAt: entry.lastUsedAt ?? null,
    createdAt: entry.createdAt,
    derivedFromUntrusted: entry.derivedFromUntrusted,
    sensitivity: entry.sensitivity,
  };
}

export async function getAgent(
  kernel: Kernel,
  agentId: string,
  opts: { memoryQuery?: string } = {},
): Promise<{
  agent: AgentMonitorRow;
  definition: AgentDefinition | null;
  runs: Array<{
    id: string;
    status: string;
    createdAt: string | null;
    finishedAt: string | null;
    error: string | null;
  }>;
  steps: Array<{
    runId: string;
    step: number;
    decision: string;
    at: string | null;
    reason: string | null;
    context: unknown;
    payload: unknown;
  }>;
  memory: AgentMemory;
} | null> {
  const listed = await listAgents(kernel);
  const agent = listed.agents.find((row) => row.id === agentId);
  if (!agent) return null;
  const definitionRows = await kernel.database
    .query<AgentDefinitionRow>(`SELECT definition, updated_at FROM agent_definitions`)
    .catch(() => [] as AgentDefinitionRow[]);
  const definition =
    definitionRows
      .map((row) => AgentDefinitionSchema.parse(row.definition))
      .find((row) => row.id === agentId) ?? null;
  const runs = await kernel.database.query<AgentRunRow>(
    `SELECT id, status, input, created_at, finished_at, error FROM workflow_runs
     WHERE workflow_id = 'agent.run'
       AND COALESCE(input->>'agentId', input->'definition'->>'id') = $1
     ORDER BY created_at DESC LIMIT 20`,
    [agentId],
  );
  const latest = runs[0];
  const steps = latest
    ? await kernel.database.query<{
        run_id: string;
        step_no: number;
        decision: string;
        payload: Record<string, unknown>;
        at: Date | string;
      }>(
        `SELECT run_id, step_no, decision, payload, at FROM agent_steps
         WHERE run_id = $1 ORDER BY step_no`,
        [latest.id],
      )
    : [];
  const allMemories = await listMemories(kernel.database, {
    agentId,
    statuses: ['active', 'proposed'],
    limit: 2000,
  });
  const memoryEntries = opts.memoryQuery
    ? (
        await recallMemories(kernel.database, {
          query: opts.memoryQuery,
          agentId,
          statuses: ['active', 'proposed'],
          limit: 50,
          floor: 0.3,
          tokenCeiling: 4000,
          touch: false,
        })
      ).map((hit) => hit.entry)
    : allMemories;
  return {
    agent,
    definition,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      createdAt: iso(run.created_at),
      finishedAt: iso(run.finished_at),
      error: run.error,
    })),
    steps: steps.map((step) => {
      const payload = step.payload as {
        reason?: unknown;
        context?: unknown;
      };
      return {
        runId: step.run_id,
        step: step.step_no,
        decision: step.decision,
        at: iso(step.at),
        reason: typeof payload.reason === 'string' ? payload.reason : null,
        context: payload.context ?? null,
        payload: step.payload,
      };
    }),
    memory: {
      entries: memoryEntries.map(memoryView),
      total: allMemories.length,
      markdown: memoryMarkdown(allMemories.filter((entry) => entry.status === 'active')),
    },
  };
}

function argsHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? {}))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Watchdog pass (17.T2): read recent kernel-owned agent steps, apply the pure
 * loop/ping-pong rules per agent, and pause + audit on a finding. The
 * watchdog never edits another agent's state beyond the pause flag.
 */
export async function watchdogScanAndPause(
  kernel: Kernel,
  opts: { lookbackMinutes?: number; actor?: string } = {},
): Promise<Array<{ agentId: string; action: string; reason: string }>> {
  const lookback = Math.max(1, Math.min(24 * 60, opts.lookbackMinutes ?? 60));
  const cursorRows = await kernel.database.query<{ scope_id: string; value: { at?: unknown } }>(
    `SELECT scope_id, value FROM shared_state
     WHERE scope_type = 'agent' AND key = 'watchdog.cursor'`,
  );
  const cursors = new Map(
    cursorRows
      .filter((row) => typeof row.value?.at === 'string')
      .map((row) => [row.scope_id, row.value.at as string]),
  );
  const pausedRows = await kernel.database.query<{ scope_id: string; value: { paused?: unknown } }>(
    `SELECT scope_id, value FROM shared_state WHERE scope_type = 'agent' AND key = 'paused'`,
  );
  const alreadyPaused = new Set(
    pausedRows.filter((row) => row.value?.paused === true).map((row) => row.scope_id),
  );
  const rows = await kernel.database.query<{
    run_id: string;
    step_no: number;
    decision: string;
    payload: Record<string, unknown>;
    at: Date | string;
    input: Record<string, unknown> | null;
  }>(
    `SELECT s.run_id, s.step_no, s.decision, s.payload, s.at, r.input
     FROM agent_steps s JOIN workflow_runs r ON r.id = s.run_id
     WHERE s.at > now() - ($1 || ' minutes')::interval
       AND r.workflow_id = 'agent.run'
     ORDER BY s.at, s.run_id, s.step_no`,
    [lookback],
  );
  const byAgent = new Map<string, AgentWatchEvent[]>();
  for (const row of rows) {
    const input = row.input ?? {};
    const agentId =
      typeof input.agentId === 'string'
        ? input.agentId
        : typeof (input.definition as { id?: unknown } | undefined)?.id === 'string'
          ? String((input.definition as { id: string }).id)
          : null;
    if (!agentId) continue;
    const at = iso(row.at) ?? new Date().toISOString();
    const cursor = cursors.get(agentId);
    if (cursor && new Date(at).getTime() <= new Date(cursor).getTime()) continue;
    const payload = row.payload as {
      tool?: unknown;
      args?: unknown;
      workItemId?: unknown;
      stateHash?: unknown;
      proofRefs?: unknown;
    };
    const events = byAgent.get(agentId) ?? [];
    if (row.decision === 'call_tool') {
      events.push({
        at,
        kind: 'tool_call',
        agentId,
        tool: typeof payload.tool === 'string' ? payload.tool : 'unknown',
        argsHash: argsHash(payload.args),
      });
    } else if (row.decision === 'handoff') {
      events.push({
        at,
        kind: 'handoff',
        agentId,
        ...(typeof payload.workItemId === 'string' ? { workItemId: payload.workItemId } : {}),
        ...(typeof payload.stateHash === 'string' ? { stateHash: payload.stateHash } : {}),
        ...(Array.isArray(payload.proofRefs)
          ? { proofRefs: payload.proofRefs.filter((ref): ref is string => typeof ref === 'string') }
          : {}),
      });
    } else {
      events.push({ at, kind: 'step', agentId });
    }
    byAgent.set(agentId, events);
  }

  const findings: Array<{ agentId: string; action: string; reason: string }> = [];
  for (const [agentId, events] of byAgent) {
    if (alreadyPaused.has(agentId)) continue;
    const decision = watchdogScan(events);
    if (decision.action === 'none') continue;
    await pauseAgent(kernel, agentId, opts.actor ?? 'watchdog', `watchdog:${decision.reason}`);
    await writeAudit(kernel.database, {
      actor: opts.actor ?? 'watchdog',
      action: 'agent.watchdog.pause',
      subject: agentId,
      payload: {
        reason: decision.reason,
        action: decision.action,
        workItemId: decision.workItemId ?? null,
      },
    });
    findings.push({ agentId, action: decision.action, reason: decision.reason });
  }
  return findings;
}

export async function listTeamRuns(kernel: Kernel): Promise<unknown> {
  const listed = await listAgents(kernel);
  return { teams: listed.teams };
}

export function assertAgentDefinition(raw: unknown): AgentDefinition {
  const parsed = AgentDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      'agent.DEFINITION_INVALID',
      'agent definition is invalid',
      parsed.error.issues,
      400,
      { category: 'validation', retryable: false },
    );
  }
  return parsed.data;
}

export async function createAgentDefinition(
  kernel: Kernel,
  input: unknown,
  actor: string,
): Promise<AgentDefinition> {
  const parsed = AgentDefinitionSchema.parse(input);
  const problems = validateAgentDefinition({
    id: parsed.id,
    displayName: parsed.displayName,
    ...(parsed.job ? { job: parsed.job } : {}),
    ...(parsed.agentReason ? { agentReason: parsed.agentReason } : {}),
  });
  if (problems.length > 0) throw invalid(problems.join('; '));
  const exists = await kernel.database.query(`SELECT 1 FROM agent_definitions WHERE id = $1`, [
    parsed.id,
  ]);
  if (exists.length > 0) {
    throw new AppError(
      'agent.EXISTS',
      `agent definition ${parsed.id} already exists`,
      undefined,
      409,
      { category: 'validation', retryable: false },
    );
  }
  await kernel.database.query(
    `INSERT INTO agent_definitions (id, display_name, definition, version)
     VALUES ($1, $2, $3, 1)`,
    [parsed.id, parsed.displayName, parsed],
  );
  await writeAudit(kernel.database, {
    actor,
    action: 'agent.created',
    subject: parsed.id,
    payload: { displayName: parsed.displayName, tools: parsed.tools },
  });
  return parsed;
}

export async function readAgentDefinition(
  kernel: Kernel,
  agentId: string,
): Promise<AgentDefinition | null> {
  const rows = await kernel.database
    .query<{ definition: unknown }>(`SELECT definition FROM agent_definitions WHERE id = $1`, [
      agentId,
    ])
    .catch(() => [] as Array<{ definition: unknown }>);
  return rows[0] ? AgentDefinitionSchema.parse(rows[0].definition) : null;
}

export type LessonPromotionTarget = 'skill' | 'profile';

export interface LessonPromotionOptions {
  memoryId: string;
  target: LessonPromotionTarget;
  actor: string;
  /** Skill owner; omitted/null creates an instance-scope skill. */
  ownerId?: string | null;
  /** Agent definition to update for a profile promotion. */
  agentId?: string;
}

export interface LessonPromotionResult {
  memoryId: string;
  target: LessonPromotionTarget;
  promoted: boolean;
  ref: string;
  archived: boolean;
}

interface LessonMemoryRow {
  [key: string]: unknown;
  id: string;
  scope: string;
  scope_id: string;
  kind: string;
  text: string;
  source_refs: string[];
  status: string;
}

async function promoteToSkill(
  kernel: Kernel,
  memory: LessonMemoryRow,
  ownerId: string | null | undefined,
): Promise<string> {
  const name = `lesson-${slugifySkillName(memory.text, 'lesson')}`.slice(0, 80);
  const description = memory.text.slice(0, 300);
  const content = skillMarkdown(
    name,
    description,
    `When this situation comes up:\n- ${memory.text}`,
  );
  const owner = ownerId ?? null;
  const existing = await kernel.database.query<{ id: string; content: string }>(
    `SELECT id, content FROM user_skills
      WHERE COALESCE(owner_id, '') = $1 AND name = $2 LIMIT 1`,
    [owner ?? '', name],
  );
  if (existing[0]) {
    if (existing[0].content !== content) {
      await kernel.database.query(
        `UPDATE user_skills
            SET description = $2, content = $3, enabled = true, suggestion = false,
                provenance = 'custom', version = version + 1, updated_at = now()
          WHERE id = $1`,
        [existing[0].id, description, content],
      );
    }
    return `promoted:skill:${name}`;
  }
  await kernel.database.query(
    `INSERT INTO user_skills
       (id, owner_id, scope, name, description, content, enabled, provenance)
     VALUES ($1,$2,$3,$4,$5,$6,true,'custom')`,
    [ulid(), owner, owner ? 'user' : 'instance', name, description, content],
  );
  return `promoted:skill:${name}`;
}

async function promoteToProfile(
  kernel: Kernel,
  memory: LessonMemoryRow,
  agentId: string | undefined,
): Promise<string> {
  const targetAgent = agentId ?? (memory.scope === 'agent' ? memory.scope_id : null);
  if (!targetAgent) throw invalid('a profile promotion needs an agent id');
  const rows = await kernel.database.query<{ definition: unknown; version: number }>(
    `SELECT definition, version FROM agent_definitions WHERE id = $1`,
    [targetAgent],
  );
  if (!rows[0]) throw notFound(`agent definition ${targetAgent} not found`);
  const definition = AgentDefinitionSchema.parse(rows[0].definition);
  if (definition.profile.includes(memory.text)) return `promoted:profile:${targetAgent}`;
  const profile = `${definition.profile}\nRule: ${memory.text}`;
  if (profile.length > 2000) {
    throw invalid(
      'the agent profile is at its 2000-character cap; shorten it before promoting this lesson',
    );
  }
  const next = AgentDefinitionSchema.parse({
    ...definition,
    profile,
    version: definition.version + 1,
  });
  await kernel.database.query(
    `UPDATE agent_definitions
        SET definition = $2, version = $3, updated_at = now()
      WHERE id = $1`,
    [targetAgent, next, next.version],
  );
  return `promoted:profile:${targetAgent}`;
}

/**
 * Promote a reviewed (`active`) lesson into a skill or the owning agent's
 * profile, then archive the memory with a link to its new home. Promotion is
 * idempotent: a memory that already carries a `promoted:` ref is not applied
 * twice. There is deliberately no new HTTP route; callers are services/UI
 * actions that already pass the RBAC gate of the surface that triggered them.
 */
export async function promoteLesson(
  kernel: Kernel,
  options: LessonPromotionOptions,
): Promise<LessonPromotionResult> {
  const rows = await kernel.database.query<LessonMemoryRow>(
    `SELECT id, scope, scope_id, kind, text, source_refs, status
       FROM memories WHERE id = $1`,
    [options.memoryId],
  );
  const memory = rows[0];
  if (!memory) throw notFound(`memory ${options.memoryId} not found`);
  if (memory.kind !== 'lesson') throw invalid('only lesson memories can be promoted');
  const existing = memory.source_refs.find((ref) => ref.startsWith('promoted:'));
  if (existing) {
    return {
      memoryId: memory.id,
      target: options.target,
      promoted: false,
      ref: existing,
      archived: memory.status === 'archived',
    };
  }
  if (memory.status !== 'active') {
    throw invalid('a lesson must be reviewed (active) before it can be promoted');
  }
  const ref =
    options.target === 'skill'
      ? await promoteToSkill(kernel, memory, options.ownerId)
      : await promoteToProfile(kernel, memory, options.agentId);
  await kernel.database.query(
    `UPDATE memories
        SET status = 'archived', source_refs = array_append(source_refs, $2)
      WHERE id = $1`,
    [memory.id, ref],
  );
  await writeAudit(kernel.database, {
    actor: options.actor,
    action: 'memory.promoted',
    subject: memory.id,
    payload: { target: options.target, ref },
  });
  return {
    memoryId: memory.id,
    target: options.target,
    promoted: true,
    ref,
    archived: true,
  };
}
