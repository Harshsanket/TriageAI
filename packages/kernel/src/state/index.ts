/** Shared state, work items and workspace decisions (Phase 16, ADR-0041). */
import { ulid } from 'ulid';

import { AppError, conflict, notFound } from '../errors.js';
import type { Database } from '../types.js';

export type ScopeType = 'org' | 'workspace' | 'team' | 'agent' | 'run';
export interface SharedStateEntry {
  scopeType: ScopeType;
  scopeId: string;
  key: string;
  value: unknown;
  version: number;
  sensitivity: string;
  updatedByRun: string | null;
  updatedAt: string;
}

export class SharedStateStore {
  constructor(private readonly database: Database) {}

  async get(scopeType: ScopeType, scopeId: string, key: string): Promise<SharedStateEntry | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM shared_state WHERE scope_type = $1 AND scope_id = $2 AND key = $3`,
      [scopeType, scopeId, key],
    );
    return rows[0] ? rowToState(rows[0]) : null;
  }

  async list(scopeType: ScopeType, scopeId: string): Promise<SharedStateEntry[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM shared_state WHERE scope_type = $1 AND scope_id = $2 ORDER BY key`,
      [scopeType, scopeId],
    );
    return rows.map(rowToState);
  }

  /** Compare-and-set: a stale write fails with state.VERSION_CONFLICT. */
  async set(args: {
    scopeType: ScopeType;
    scopeId: string;
    key: string;
    value: unknown;
    expectedVersion?: number;
    sensitivity?: string;
    runId?: string;
    agentId?: string;
  }): Promise<SharedStateEntry> {
    const current = await this.get(args.scopeType, args.scopeId, args.key);
    if (args.expectedVersion !== undefined && (current?.version ?? 0) !== args.expectedVersion) {
      throw conflict('state.VERSION_CONFLICT');
    }
    const nextVersion = (current?.version ?? 0) + 1;
    const rows = await this.database.query<Record<string, unknown>>(
      `INSERT INTO shared_state
         (scope_type, scope_id, key, value, version, sensitivity, updated_by_run, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (scope_type, scope_id, key) DO UPDATE
         SET value = EXCLUDED.value, version = EXCLUDED.version,
             sensitivity = EXCLUDED.sensitivity, updated_by_run = EXCLUDED.updated_by_run,
             updated_at = now()
       RETURNING *`,
      [
        args.scopeType,
        args.scopeId,
        args.key,
        args.value,
        nextVersion,
        args.sensitivity ?? current?.sensitivity ?? 'internal',
        args.runId ?? null,
      ],
    );
    await this.database.query(
      `INSERT INTO state_events (id, scope_type, scope_id, key, version, value, run_id, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ulid(),
        args.scopeType,
        args.scopeId,
        args.key,
        nextVersion,
        args.value,
        args.runId ?? null,
        args.agentId ?? null,
      ],
    );
    return rowToState(rows[0] as Record<string, unknown>);
  }
}

function rowToState(row: Record<string, unknown>): SharedStateEntry {
  return {
    scopeType: row.scope_type as ScopeType,
    scopeId: row.scope_id as string,
    key: row.key as string,
    value: row.value,
    version: Number(row.version),
    sensitivity: String(row.sensitivity),
    updatedByRun: (row.updated_by_run as string | null) ?? null,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export type WorkStatus =
  'todo' | 'claimed' | 'in_progress' | 'in_review' | 'done' | 'failed' | 'blocked';
export interface WorkItem {
  id: string;
  workspaceId: string;
  rootRunId: string;
  title: string;
  status: WorkStatus;
  ownerAgentId?: string;
  leaseExpiresAt?: string;
  dependsOn: string[];
  inputRefs: string[];
  doneWhen: string;
  proofRefs: string[];
  checkedBy?: string;
  blockedReason?: string;
  review?: { failed: string; saw: string; fix: string; attempt: number };
}

export class WorkItemStore {
  constructor(private readonly database: Database) {}

  async create(args: {
    workspaceId: string;
    rootRunId: string;
    title: string;
    doneWhen: string;
    dependsOn?: string[];
    inputRefs?: string[];
  }): Promise<WorkItem> {
    const id = ulid();
    const rows = await this.database.query<Record<string, unknown>>(
      `INSERT INTO work_items
         (id, workspace_id, root_run_id, title, done_when, depends_on, input_refs)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        id,
        args.workspaceId,
        args.rootRunId,
        args.title,
        args.doneWhen,
        args.dependsOn ?? [],
        args.inputRefs ?? [],
      ],
    );
    return rowToItem(rows[0] as Record<string, unknown>);
  }

  async get(id: string): Promise<WorkItem | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM work_items WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToItem(rows[0]) : null;
  }

  /** Exactly one claimant wins; an expired lease returns the item to `todo`. */
  async claim(id: string, agentId: string, leaseMs = 10 * 60_000): Promise<WorkItem> {
    const rows = await this.database.query<Record<string, unknown>>(
      `UPDATE work_items
       SET status = 'claimed', owner_agent_id = $2,
           lease_expires_at = now() + ($3 || ' milliseconds')::interval, updated_at = now()
       WHERE id = $1 AND status IN ('todo','claimed')
         AND (lease_expires_at IS NULL OR lease_expires_at < now())
         AND NOT EXISTS (
           SELECT 1 FROM unnest(depends_on) dep
           JOIN work_items parent ON parent.id = dep
           WHERE parent.status <> 'done'
         )
       RETURNING *`,
      [id, agentId, leaseMs],
    );
    if (!rows[0]) {
      const exists = await this.database.query(`SELECT 1 FROM work_items WHERE id = $1`, [id]);
      throw exists.length > 0
        ? new AppError('work.ALREADY_CLAIMED', 'work item is not claimable', undefined, 409)
        : notFound(`work item ${id} not found`);
    }
    return rowToItem(rows[0]);
  }

  async review(
    id: string,
    checkerId: string,
    args: { pass: boolean; proofRefs?: string[]; failed?: string; saw?: string; fix?: string },
  ): Promise<WorkItem> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM work_items WHERE id = $1`,
      [id],
    );
    const item = rows[0] ? rowToItem(rows[0]) : null;
    if (!item) throw notFound(`work item ${id} not found`);
    if (item.ownerAgentId === checkerId) {
      throw new AppError('work.SELF_REVIEW', 'nobody grades their own work', undefined, 409);
    }
    const proof = args.proofRefs ?? item.proofRefs;
    if (args.pass && proof.length === 0) {
      throw new AppError('work.PROOF_REQUIRED', 'a proof ref is required for done', undefined, 400);
    }
    const attempt = (item.review?.attempt ?? 0) + (args.pass ? 0 : 1);
    const blocked = !args.pass && attempt >= 2;
    const updated = await this.database.query<Record<string, unknown>>(
      `UPDATE work_items
       SET status = $2, proof_refs = $3, checked_by = $4, review = $5,
           blocked_reason = $6, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        id,
        args.pass ? 'done' : blocked ? 'blocked' : 'in_progress',
        proof,
        checkerId,
        args.pass
          ? null
          : {
              failed: args.failed ?? 'criterion',
              saw: args.saw ?? '',
              fix: args.fix ?? '',
              attempt,
            },
        blocked ? 'two failed reviews' : null,
      ],
    );
    return rowToItem(updated[0] as Record<string, unknown>);
  }
}

function rowToItem(row: Record<string, unknown>): WorkItem {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    rootRunId: row.root_run_id as string,
    title: row.title as string,
    status: row.status as WorkStatus,
    ...(row.owner_agent_id ? { ownerAgentId: row.owner_agent_id as string } : {}),
    ...(row.lease_expires_at
      ? { leaseExpiresAt: new Date(row.lease_expires_at as string).toISOString() }
      : {}),
    dependsOn: (row.depends_on as string[]) ?? [],
    inputRefs: (row.input_refs as string[]) ?? [],
    doneWhen: row.done_when as string,
    proofRefs: (row.proof_refs as string[]) ?? [],
    ...(row.checked_by ? { checkedBy: row.checked_by as string } : {}),
    ...(row.blocked_reason ? { blockedReason: row.blocked_reason as string } : {}),
    ...(row.review ? { review: row.review as WorkItem['review'] } : {}),
  };
}

export interface WorkspaceDecision {
  id: string;
  workspaceId: string;
  decision: string;
  reason: string;
  alternatives: string[];
  madeBy: string;
  supersedes?: string;
  at: string;
}

export class WorkspaceDecisionStore {
  constructor(private readonly database: Database) {}

  async record(args: {
    workspaceId: string;
    decision: string;
    reason: string;
    alternatives?: string[];
    madeBy: string;
    supersedes?: string;
  }): Promise<WorkspaceDecision> {
    const id = ulid();
    const rows = await this.database.query<Record<string, unknown>>(
      `INSERT INTO workspace_decisions
         (id, workspace_id, decision, reason, alternatives, made_by, supersedes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        id,
        args.workspaceId,
        args.decision,
        args.reason,
        args.alternatives ?? [],
        args.madeBy,
        args.supersedes ?? null,
      ],
    );
    const row = rows[0] as Record<string, unknown>;
    return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      decision: row.decision as string,
      reason: row.reason as string,
      alternatives: (row.alternatives as string[]) ?? [],
      madeBy: row.made_by as string,
      ...(row.supersedes ? { supersedes: row.supersedes as string } : {}),
      at: new Date(row.at as string).toISOString(),
    };
  }

  async list(workspaceId: string): Promise<WorkspaceDecision[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM workspace_decisions WHERE workspace_id = $1 ORDER BY at`,
      [workspaceId],
    );
    return rows.map((row) => ({
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      decision: row.decision as string,
      reason: row.reason as string,
      alternatives: (row.alternatives as string[]) ?? [],
      madeBy: row.made_by as string,
      ...(row.supersedes ? { supersedes: row.supersedes as string } : {}),
      at: new Date(row.at as string).toISOString(),
    }));
  }
}
