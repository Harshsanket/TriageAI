/** Per-class retention planning (Phase 18.8/18.T17). */
import { DEFAULT_DATA_CLASSES, type DataClass } from '../data/classes.js';
import { quoteIdent } from '../storage.js';
import type { Database } from '../types.js';

export interface ClassRetentionAction {
  classId: string;
  action: 'delete' | 'keep' | 'legal_hold';
  days?: number;
  reason: string;
}

export function planClassRetention(
  classes: DataClass[],
  args: { now?: Date; legalHolds?: string[] } = {},
): ClassRetentionAction[] {
  const held = new Set(args.legalHolds ?? []);
  return classes.map((cls) => {
    if (held.has(cls.id)) {
      return { classId: cls.id, action: 'legal_hold', reason: 'legal hold' };
    }
    if (cls.retention.mode !== 'days' || cls.retention.days === undefined) {
      return {
        classId: cls.id,
        action: 'keep',
        reason: `mode:${cls.retention.mode}`,
      };
    }
    return {
      classId: cls.id,
      action: 'delete',
      days: cls.retention.days,
      reason: `older than ${cls.retention.days} days`,
    };
  });
}

/**
 * The minimal kernel-owned table mapping the class runner may delete from.
 * Module-owned tables are deliberately absent: modules enforce their own
 * retention tasks and the kernel never crosses a module schema boundary.
 */
export interface CoreRetentionTarget {
  table: string;
  timeColumn: string;
  /** Extra predicate for classes whose rows are not all eligible. */
  where?: string;
  /** RetentionConfig window that overrides the class period when configured. */
  configKey?: 'runs' | 'decisions' | 'audit' | 'candidates' | 'deadletters';
  partitioned?: boolean;
}

export const CORE_RETENTION_TARGETS: Record<string, CoreRetentionTarget> = {
  workflow_runs: {
    table: 'workflow_runs',
    timeColumn: 'finished_at',
    where: `finished_at IS NOT NULL AND status IN ('SUCCEEDED','FAILED','CANCELLED','AWAITING')`,
    configKey: 'runs',
  },
  decision_records: {
    table: 'decision_records',
    timeColumn: 'created_at',
    configKey: 'decisions',
    partitioned: true,
  },
  stage_runs: {
    table: 'stage_runs',
    timeColumn: 'created_at',
    partitioned: true,
  },
  audit_events: {
    table: 'audit_events',
    timeColumn: 'created_at',
    configKey: 'audit',
    partitioned: true,
  },
  state_events: {
    table: 'state_events',
    timeColumn: 'at',
    partitioned: true,
  },
  cost_ledger: {
    table: 'cost_ledger',
    timeColumn: 'at',
    partitioned: true,
  },
  outbox_events: {
    table: 'outbox_events',
    timeColumn: 'created_at',
    partitioned: true,
  },
  app_boots: {
    table: 'app_boots',
    timeColumn: 'at',
    partitioned: true,
  },
  candidate_examples: {
    table: 'candidate_examples',
    timeColumn: 'created_at',
    where: `status IN ('proposed','rejected')`,
    configKey: 'candidates',
  },
  queue_deadletters: {
    table: 'queue_deadletters',
    timeColumn: 'created_at',
    configKey: 'deadletters',
  },
  activity_events: {
    table: 'activity_events',
    timeColumn: 'at',
  },
};

/** Row-level delete for a non-partitioned core class. */
export async function deleteExpiredRows(
  database: Database,
  classId: string,
  cutoff: Date,
): Promise<number> {
  const target = CORE_RETENTION_TARGETS[classId];
  if (!target || target.partitioned) return 0;
  const where = [`${quoteIdent(target.timeColumn)} < $1`];
  if (target.where) where.push(target.where);
  const rows = await database.query(
    `DELETE FROM ${quoteIdent(target.table)} WHERE ${where.join(' AND ')} RETURNING 1`,
    [cutoff],
  );
  return rows.length;
}

export interface ForgetMeResult {
  subject: string;
  deleted: Record<string, number>;
  skipped: Array<{ classId: string; reason: string }>;
}

/**
 * Delete a subject's personal data from kernel-owned classes only. Module
 * tables are reported as skipped: the host must call each module's own erasure
 * hook so the kernel never reaches into a module schema (ADR-0054).
 */
export async function forgetSubject(
  database: Database,
  subject: string,
  classes: Record<string, DataClass> = DEFAULT_DATA_CLASSES,
): Promise<ForgetMeResult> {
  const deleted: Record<string, number> = {};
  const skipped: Array<{ classId: string; reason: string }> = [];
  const aliases = new Set([subject.toLowerCase()]);
  const identity = await database
    .query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1) OR id = $1 LIMIT 1`,
      [subject],
    )
    .catch(() => []);
  if (identity[0]?.id) aliases.add(identity[0].id.toLowerCase());
  const candidates = Object.values(classes)
    .filter((cls) => cls.retention.personalData)
    .sort((a, b) => (a.id === 'users' ? 1 : 0) - (b.id === 'users' ? 1 : 0));

  for (const cls of candidates) {
    if (cls.owner !== 'kernel') {
      skipped.push({ classId: cls.id, reason: `module-owned:${cls.owner}` });
      continue;
    }
    if (cls.id === 'audit_events') {
      // The hash chain is append-only; erasing audit rows is an explicit
      // retention/legal-hold decision, never a side effect of "forget me".
      skipped.push({ classId: cls.id, reason: 'append-only audit chain' });
      continue;
    }
    if (!cls.subjectColumns?.length) {
      skipped.push({ classId: cls.id, reason: 'no subject column' });
      continue;
    }
    const table = quoteIdent(cls.id);
    const match = cls.subjectColumns
      .map((column) => `lower(${quoteIdent(column)}::text) = ANY($1::text[])`)
      .join(' OR ');
    try {
      const rows = await database.query(`DELETE FROM ${table} WHERE ${match} RETURNING 1`, [
        [...aliases],
      ]);
      deleted[cls.id] = rows.length;
    } catch {
      skipped.push({ classId: cls.id, reason: 'delete failed' });
    }
  }

  return { subject, deleted, skipped };
}
