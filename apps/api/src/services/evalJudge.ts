/**
 * Settings-backed judge suspension (Phase 18.1/18.T1).
 *
 * The judge is evaluated against reviewer agreement; three consecutive
 * below-floor agreements suspend it until an admin re-enables it. The flag is a
 * settings row so it survives restarts and is visible to the nightly runner.
 */
import { readSetting, shouldSuspend } from '@triageai/kernel';
import type { Database } from '@triageai/kernel';

import { writeAudit } from './audit.js';

export const JUDGE_STATE_KEY = 'evals.judge';
export const DEFAULT_AGREEMENT_FLOOR = 0.8;
export const DEFAULT_CONSECUTIVE_FAILURES = 3;

export interface JudgeState {
  suspended: boolean;
  reason: string | null;
  /** Most recent reviewer-agreement scores (0..1), newest last. */
  agreements: number[];
  updatedAt: string | null;
}

function normalize(value: Partial<JudgeState> | null): JudgeState {
  return {
    suspended: value?.suspended === true,
    reason: typeof value?.reason === 'string' ? value.reason : null,
    agreements: Array.isArray(value?.agreements)
      ? value.agreements.filter(
          (score): score is number => typeof score === 'number' && Number.isFinite(score),
        )
      : [],
    updatedAt: typeof value?.updatedAt === 'string' ? value.updatedAt : null,
  };
}

export async function getJudgeState(database: Database): Promise<JudgeState> {
  return normalize(await readSetting<Partial<JudgeState>>(database, JUDGE_STATE_KEY));
}

async function writeJudgeState(
  database: Database,
  state: JudgeState,
  actor: string | null,
  action: string,
  reason: string | null,
): Promise<void> {
  await database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JUDGE_STATE_KEY, state, actor],
  );
  await writeAudit(database, {
    actor,
    action,
    subject: JUDGE_STATE_KEY,
    payload: {
      suspended: state.suspended,
      reason,
      agreements: state.agreements,
    },
  });
}

/**
 * Record one judge-vs-human agreement score and suspend after the configured
 * run of failures. The pure rule lives in `shouldSuspend`.
 */
export async function recordJudgeAgreement(
  database: Database,
  agreement: number,
  options: {
    actor?: string | null;
    floor?: number;
    consecutiveFailures?: number;
    maxSamples?: number;
  } = {},
): Promise<JudgeState> {
  const floor = options.floor ?? DEFAULT_AGREEMENT_FLOOR;
  const consecutiveFailures = options.consecutiveFailures ?? DEFAULT_CONSECUTIVE_FAILURES;
  const current = await getJudgeState(database);
  const agreements = [...current.agreements, Math.min(1, Math.max(0, agreement))].slice(
    -(options.maxSamples ?? 20),
  );
  const shouldBeSuspended =
    current.suspended ||
    shouldSuspend(agreements, {
      consecutiveFailures,
      floor,
    });
  const state: JudgeState = {
    suspended: shouldBeSuspended,
    reason: shouldBeSuspended
      ? (current.reason ??
        `judge agreement fell below ${floor} for ${consecutiveFailures} consecutive reviews`)
      : null,
    agreements,
    updatedAt: new Date().toISOString(),
  };
  await writeJudgeState(
    database,
    state,
    options.actor ?? 'evals.judge',
    current.suspended === state.suspended ? 'evals.judge_scored' : 'evals.judge_suspended',
    state.reason,
  );
  return state;
}

/** Manual admin reset/disable; audited and effective for the next judge call. */
export async function setJudgeSuspended(
  database: Database,
  suspended: boolean,
  options: { reason?: string | null; actor?: string | null; resetAgreements?: boolean } = {},
): Promise<JudgeState> {
  const current = await getJudgeState(database);
  const state: JudgeState = {
    suspended,
    reason: suspended ? (options.reason ?? 'suspended by an admin') : null,
    agreements: options.resetAgreements === false ? current.agreements : [],
    updatedAt: new Date().toISOString(),
  };
  await writeJudgeState(
    database,
    state,
    options.actor ?? 'admin',
    suspended ? 'evals.judge_suspended' : 'evals.judge_resumed',
    state.reason,
  );
  return state;
}

/** Judge a sampled run only while the judge is not suspended. */
export async function judgeAllowed(database: Database): Promise<boolean> {
  return !(await getJudgeState(database)).suspended;
}
