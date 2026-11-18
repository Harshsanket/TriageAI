/** Human approval queue (Phase 15, ADR-0029 amendment). */
import { ulid } from 'ulid';

import { applyExpiry } from './approvals/expiry.js';
import type { ExpiryOutcome } from './approvals/expiry.js';
import { previewSummary } from './approvals/preview.js';
import { conflict, invalid, notFound } from './errors.js';
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

/** Pending calls of the same tool in one run, shown as one decision (15.T9). */
export interface ApprovalBatch {
  runId: string;
  toolName: string;
  count: number;
  summary: string;
  items: Approval[];
  expiresAt: string;
  onExpiry: ApprovalExpiry;
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

  async get(id: string): Promise<Approval | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM approvals WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToApproval(rows[0]) : null;
  }

  /**
   * Pending approvals grouped by `(runId, toolName)`. Each item stays its own
   * row; the batch is only a presentation/decision surface.
   */
  async listBatches(
    status: ApprovalStatus | 'all' = 'pending',
    limit = 200,
  ): Promise<ApprovalBatch[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM approvals
       WHERE ($1 = 'all' OR status = $1) ORDER BY created_at ASC LIMIT $2`,
      [status, limit],
    );
    const groups = new Map<string, Approval[]>();
    for (const row of rows.map(rowToApproval)) {
      const key = `${row.runId}\u0000${row.toolName}`;
      const items = groups.get(key);
      if (items) items.push(row);
      else groups.set(key, [row]);
    }
    return [...groups.values()].map((items) => {
      const first = items[0] as Approval;
      const summary = previewSummary(first.preview) ?? first.toolName;
      const onExpiry = items.every((item) => item.onExpiry === first.onExpiry)
        ? first.onExpiry
        : 'escalate';
      return {
        runId: first.runId,
        toolName: first.toolName,
        count: items.length,
        summary: items.length === 1 ? summary : `${items.length} × ${summary}`,
        items,
        expiresAt: items
          .map((item) => item.expiresAt)
          .sort((left, right) => left.localeCompare(right))[0] as string,
        onExpiry,
      };
    });
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

  /**
   * Decide a subset atomically: every id must still be pending, or nothing is
   * changed. Each item keeps its own row and audit trail (15.T9).
   */
  async decideBatch(
    ids: string[],
    outcome: 'approve' | 'reject',
    approver: string,
    reason?: string,
  ): Promise<Approval[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw invalid('at least one approval id is required');
    if (outcome === 'reject' && !reason?.trim()) {
      throw invalid('a rejection reason is required');
    }
    return this.database.transaction(async (tx) => {
      const rows = await tx.query<Record<string, unknown>>(
        `SELECT id, status FROM approvals WHERE id = ANY($1::text[]) FOR UPDATE`,
        [unique],
      );
      if (rows.length !== unique.length) {
        const found = new Set(rows.map((row) => row.id as string));
        throw notFound(`approval ${unique.find((id) => !found.has(id))} not found`);
      }
      const notPending = rows.find((row) => row.status !== 'pending');
      if (notPending) {
        throw conflict(`approval ${notPending.id} is no longer pending`);
      }
      const updated = await tx.query<Record<string, unknown>>(
        `UPDATE approvals
         SET status = $2, approver = $3, reason = $4, decided_at = now()
         WHERE id = ANY($1::text[]) RETURNING *`,
        [unique, outcome === 'approve' ? 'approved' : 'rejected', approver, reason ?? null],
      );
      const byId = new Map(updated.map((row) => [row.id as string, rowToApproval(row)]));
      return unique.map((id) => byId.get(id) as Approval);
    });
  }

  /** Mark due approvals expired; callers apply `onExpiry` (escalate/cancel/draft). */
  async expireDue(): Promise<Approval[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `UPDATE approvals SET status = 'expired', decided_at = now()
       WHERE status = 'pending' AND expires_at < now() RETURNING *`,
    );
    return rows.map(rowToApproval);
  }

  /**
   * Apply the pre-decided expiry action to one row. `park_as_draft` keeps the
   * prepared action in the approval's preview and marks the reason, so a human
   * can still send it later without a new table.
   */
  async applyExpiryTo(id: string): Promise<{ approval: Approval; outcome: ExpiryOutcome }> {
    const current = await this.get(id);
    if (!current) throw notFound(`approval ${id} not found`);
    if (current.status === 'approved' || current.status === 'rejected') {
      throw conflict(`approval ${id} was already decided`);
    }
    if (current.status === 'pending' && new Date(current.expiresAt).getTime() > Date.now()) {
      throw conflict(`approval ${id} has not expired yet`);
    }
    const outcome = applyExpiry(current);
    const rows =
      outcome.action === 'park_as_draft'
        ? await this.database.query<Record<string, unknown>>(
            `UPDATE approvals
             SET status = 'expired', decided_at = COALESCE(decided_at, now()),
                 preview = jsonb_set(COALESCE(preview, '{}'::jsonb), '{draft}', $2::jsonb, true),
                 reason = $3
             WHERE id = $1 RETURNING *`,
            [id, outcome.draft, outcome.reason],
          )
        : await this.database.query<Record<string, unknown>>(
            `UPDATE approvals
             SET status = 'expired', decided_at = COALESCE(decided_at, now()), reason = $2
             WHERE id = $1 RETURNING *`,
            [id, outcome.reason],
          );
    return { approval: rowToApproval(rows[0] as Record<string, unknown>), outcome };
  }

  /** Persist a deterministic run receipt on a parked approval (no migration). */
  async attachReceipt(id: string, receipt: unknown): Promise<Approval> {
    const rows = await this.database.query<Record<string, unknown>>(
      `UPDATE approvals
       SET preview = jsonb_set(COALESCE(preview, '{}'::jsonb), '{receipt}', $2::jsonb, true)
       WHERE id = $1 RETURNING *`,
      [id, receipt],
    );
    if (!rows[0]) throw notFound(`approval ${id} not found`);
    return rowToApproval(rows[0]);
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
