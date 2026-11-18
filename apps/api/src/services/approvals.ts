/**
 * Approval policy + per-flow autonomy persistence (Phase 15.T3/T10).
 *
 * Both live in the existing `settings` JSONB table, so there is no migration:
 * `approval.policy` and `autonomy.flows`. Reads fail safe to the defaults.
 */
import {
  APPROVAL_POLICY_SETTING_KEY,
  ApprovalPolicySchema,
  FlowAutonomySettingsSchema,
  autonomyForAction,
  flowAutonomyKey,
  isCleanAutonomyAction,
  loadApprovalPolicy,
  nextAutonomy,
} from '@triageai/kernel';
import type {
  ApprovalPolicy,
  AutonomyAction,
  AutonomyLevel,
  Database,
  FlowAutonomyRecord,
} from '@triageai/kernel';

import { writeAudit } from './audit.js';

export const APPROVAL_POLICY_KEY = APPROVAL_POLICY_SETTING_KEY;
export const AUTONOMY_FLOWS_KEY = 'autonomy.flows';

type Queryable = Pick<Database, 'query'>;

async function readSetting<T>(database: Queryable, key: string): Promise<T | null> {
  const rows = await database
    .query<{ value: T }>(`SELECT value FROM settings WHERE key = $1`, [key])
    .catch(() => []);
  return rows[0]?.value ?? null;
}

async function writeSetting(
  database: Queryable,
  key: string,
  value: unknown,
  actor: string | null,
): Promise<void> {
  await database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, value, actor ?? 'system'],
  );
}

export async function readApprovalPolicy(database: Database): Promise<ApprovalPolicy> {
  return loadApprovalPolicy(database);
}

export async function writeApprovalPolicy(
  database: Database,
  policy: ApprovalPolicy,
  actor: string | null,
): Promise<ApprovalPolicy> {
  const parsed = ApprovalPolicySchema.parse(policy);
  await writeSetting(database, APPROVAL_POLICY_KEY, parsed, actor);
  await writeAudit(database, {
    actor,
    action: 'approval_policy.update',
    subject: APPROVAL_POLICY_KEY,
    payload: {
      mode: parsed.mode,
      allowlist: parsed.allowlist.length,
      hardFloor: parsed.hardFloor.length,
      onExpiry: parsed.onExpiry,
    },
  });
  return parsed;
}

export interface FlowAutonomyView extends FlowAutonomyRecord {
  key: string;
  suggestion: { level: AutonomyLevel; reason: string } | null;
}

export async function readFlowAutonomy(database: Queryable): Promise<FlowAutonomyRecord[]> {
  const stored = await readSetting<unknown>(database, AUTONOMY_FLOWS_KEY);
  const parsed = FlowAutonomySettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data.flows : [];
}

export async function listFlowAutonomy(database: Database): Promise<FlowAutonomyView[]> {
  const records = await readFlowAutonomy(database);
  const levels: AutonomyLevel[] = ['investigate', 'draft', 'internal_note', 'autopilot'];
  return records.map((record) => {
    const index = levels.indexOf(record.level);
    const suggestion =
      record.cleanRunStreak >= record.promoteAfter && index < levels.length - 1
        ? { level: levels[index + 1] as AutonomyLevel, reason: 'promotion_suggested' }
        : null;
    return { ...record, key: flowAutonomyKey(record.flow, record.category), suggestion };
  });
}

/**
 * Record one run for a flow. Clean runs extend the streak (promotion stays a
 * suggestion); a dirty run or a production target demotes immediately and the
 * change is audited.
 */
export async function observeFlowRun(
  database: Database,
  args: {
    flow: string;
    category?: string | null;
    action: AutonomyAction;
    clean?: boolean;
    targetProduction?: boolean;
    by?: string;
  },
): Promise<{ record: FlowAutonomyRecord; changed: boolean; reason: string }> {
  const actor = args.by ?? 'system';
  const outcome = await database.transaction(async (tx) => {
    // Concurrent runs of the same (or different) flows share one JSONB row;
    // serialise the read-modify-write so neither update is lost.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [AUTONOMY_FLOWS_KEY]);
    const records = await readFlowAutonomy(tx);
    const category = args.category ?? null;
    const existing = records.find(
      (record) => record.flow === args.flow && record.category === category,
    );
    const current: FlowAutonomyRecord = existing ?? {
      flow: args.flow,
      category,
      // Customer-facing flows start at draft; promotion is never automatic.
      level: 'draft',
      cleanRunStreak: 0,
      promoteAfter: 5,
      lastChange: null,
    };
    const clean = args.clean ?? isCleanAutonomyAction(args.action);
    const next = nextAutonomy(current, {
      clean,
      ...(args.targetProduction === undefined ? {} : { targetProduction: args.targetProduction }),
    });
    const record: FlowAutonomyRecord = {
      ...current,
      level: next.level,
      cleanRunStreak: next.cleanRunStreak,
      ...(next.changed
        ? {
            lastChange: {
              from: current.level,
              to: next.level,
              reason: next.reason,
              by: actor,
              at: new Date().toISOString(),
            },
          }
        : {}),
    };
    const flows = existing
      ? records.map((entry) => (entry === existing ? record : entry))
      : [...records, record];
    await writeSetting(tx, AUTONOMY_FLOWS_KEY, { flows }, actor);
    return {
      record,
      changed: next.changed,
      reason: next.reason,
      from: current.level,
      to: next.level,
    };
  });
  if (outcome.changed) {
    await writeAudit(database, {
      actor,
      action: 'autonomy.changed',
      subject: flowAutonomyKey(args.flow, args.category ?? null),
      payload: {
        flow: args.flow,
        category: args.category ?? null,
        from: outcome.from,
        to: outcome.to,
        reason: outcome.reason,
        action: args.action,
        observedLevel: autonomyForAction(args.action),
      },
    });
  }
  return { record: outcome.record, changed: outcome.changed, reason: outcome.reason };
}

/** Accept a suggested level (the only way a flow is raised). */
export async function acceptAutonomyLevel(
  database: Database,
  args: {
    flow: string;
    category?: string | null;
    level: AutonomyLevel;
    actor: string | null;
  },
): Promise<FlowAutonomyRecord> {
  const outcome = await database.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [AUTONOMY_FLOWS_KEY]);
    const records = await readFlowAutonomy(tx);
    const category = args.category ?? null;
    const existing = records.find(
      (record) => record.flow === args.flow && record.category === category,
    );
    const current: FlowAutonomyRecord = existing ?? {
      flow: args.flow,
      category,
      level: args.level,
      cleanRunStreak: 0,
      promoteAfter: 5,
      lastChange: null,
    };
    const record: FlowAutonomyRecord = {
      ...current,
      level: args.level,
      cleanRunStreak: 0,
      lastChange: {
        from: current.level,
        to: args.level,
        reason: 'accepted',
        by: args.actor ?? 'admin',
        at: new Date().toISOString(),
      },
    };
    const flows = existing
      ? records.map((entry) => (entry === existing ? record : entry))
      : [...records, record];
    await writeSetting(tx, AUTONOMY_FLOWS_KEY, { flows }, args.actor);
    return { record, from: current.level, category };
  });
  await writeAudit(database, {
    actor: args.actor,
    action: 'autonomy.accepted',
    subject: flowAutonomyKey(args.flow, outcome.category),
    payload: {
      flow: args.flow,
      category: outcome.category,
      from: outcome.from,
      to: args.level,
    },
  });
  return outcome.record;
}
