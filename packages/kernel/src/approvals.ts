/** Human approval queue (Phase 15, ADR-0029 amendment). */
import { ulid } from 'ulid';

import { conflict, notFound } from './errors.js';
import type { Database } from './types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalExpiry = 'escalate' | 'cancel' | 'park_as_draft';

export interface Approval {
  id: string;
  runId: string;
  stepId: string;
  toolName: string;
  input: unknown;
  preview: unknown;
  status: ApprovalStatus;
  onExpiry: ApprovalExpiry;
  approver: string | null;
  reason: string | null;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
}

export class ApprovalStore {
  constructor(private readonly database: Database) {}

  async create(args: {
    runId: string;
    stepId: string;
    toolName: string;
    input: unknown;
    preview?: unknown;
    expiresAfterMs: number;
    onExpiry?: ApprovalExpiry;
  }): Promise<Approval> {
    const id = ulid();
    const rows = await this.database.query<Record<string, unknown>>(
      `INSERT INTO approvals
         (id, run_id, step_id, tool_name, input, preview, expires_at, on_expiry)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval, $8)
       RETURNING *`,
      [
        id,
        args.runId,
        args.stepId,
        args.toolName,
        args.input,
        args.preview ?? null,
        args.expiresAfterMs,
        args.onExpiry ?? 'escalate',
      ],
    );
    return rowToApproval(rows[0] as Record<string, unknown>);
  }

  async list(status: ApprovalStatus | 'all' = 'pending', limit = 50): Promise<Approval[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM approvals
       WHERE ($1 = 'all' OR status = $1) ORDER BY created_at DESC LIMIT $2`,
      [status, limit],
    );
    return rows.map(rowToApproval);
  }

  async decide(
    id: string,
    approved: boolean,
    approver: string,
    reason?: string,
  ): Promise<Approval> {
    const rows = await this.database.query<Record<string, unknown>>(
      `UPDATE approvals
       SET status = $2, approver = $3, reason = $4, decided_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, approved ? 'approved' : 'rejected', approver, reason ?? null],
    );
    if (!rows[0]) {
      const exists = await this.database.query(`SELECT 1 FROM approvals WHERE id = $1`, [id]);
      if (exists.length === 0) throw notFound(`approval ${id} not found`);
      throw conflict(`approval ${id} is no longer pending`);
    }
    return rowToApproval(rows[0]);
  }

  /** Mark due approvals expired; callers apply `onExpiry` (escalate/cancel/draft). */
  async expireDue(): Promise<Approval[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `UPDATE approvals SET status = 'expired', decided_at = now()
       WHERE status = 'pending' AND expires_at < now() RETURNING *`,
    );
    return rows.map(rowToApproval);
  }
}

function rowToApproval(row: Record<string, unknown>): Approval {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    stepId: row.step_id as string,
    toolName: row.tool_name as string,
    input: row.input,
    preview: row.preview,
    status: row.status as ApprovalStatus,
    onExpiry: row.on_expiry as ApprovalExpiry,
    approver: (row.approver as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    expiresAt: new Date(row.expires_at as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
    decidedAt: row.decided_at ? new Date(row.decided_at as string).toISOString() : null,
  };
}
