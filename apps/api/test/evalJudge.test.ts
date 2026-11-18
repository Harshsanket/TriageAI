import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import {
  getJudgeState,
  JUDGE_STATE_KEY,
  judgeAllowed,
  recordJudgeAgreement,
  setJudgeSuspended,
} from '../src/services/evalJudge.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('judge suspension state (phase 18.T1)', () => {
  let app: FastifyInstance & { kernel?: Kernel };

  beforeAll(async () => {
    app = (await buildApp({ quiet: true })) as FastifyInstance & { kernel?: Kernel };
  });

  afterAll(async () => {
    await cleanup();
    await app?.close();
  });

  beforeEach(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    if (!app?.kernel) return;
    await app.kernel.database.query(`DELETE FROM settings WHERE key = $1`, [JUDGE_STATE_KEY]);
    await app.kernel.database.query(`DELETE FROM audit_events WHERE action LIKE 'evals.judge%'`);
  }

  it('suspends after three consecutive low reviewer-agreement scores', async () => {
    expect(await getJudgeState(app.kernel!.database)).toMatchObject({
      suspended: false,
      agreements: [],
    });

    await recordJudgeAgreement(app.kernel!.database, 0.9, { actor: 'reviewer' });
    await recordJudgeAgreement(app.kernel!.database, 0.4, { actor: 'reviewer' });
    await recordJudgeAgreement(app.kernel!.database, 0.5, { actor: 'reviewer' });
    expect((await getJudgeState(app.kernel!.database)).suspended).toBe(false);

    const state = await recordJudgeAgreement(app.kernel!.database, 0.3, { actor: 'reviewer' });
    expect(state).toMatchObject({ suspended: true, agreements: [0.9, 0.4, 0.5, 0.3] });
    expect(state.reason).toContain('below');
    expect(await judgeAllowed(app.kernel!.database)).toBe(false);

    const persisted = await app.kernel!.database.query<{ value: { suspended: boolean } }>(
      `SELECT value FROM settings WHERE key = $1`,
      [JUDGE_STATE_KEY],
    );
    expect(persisted[0]?.value.suspended).toBe(true);

    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'evals.judge_suspended'`,
    );
    expect(audit).toHaveLength(1);
  });

  it('resumes after an admin reset and does not suspend on a mixed window', async () => {
    await recordJudgeAgreement(app.kernel!.database, 0.4);
    await recordJudgeAgreement(app.kernel!.database, 0.5);
    await recordJudgeAgreement(app.kernel!.database, 0.3);
    expect((await getJudgeState(app.kernel!.database)).suspended).toBe(true);

    const resumed = await setJudgeSuspended(app.kernel!.database, false, {
      actor: 'admin',
      resetAgreements: true,
    });
    expect(resumed).toMatchObject({ suspended: false, reason: null, agreements: [] });
    expect(await judgeAllowed(app.kernel!.database)).toBe(true);

    await recordJudgeAgreement(app.kernel!.database, 0.4);
    await recordJudgeAgreement(app.kernel!.database, 0.9);
    await recordJudgeAgreement(app.kernel!.database, 0.5);
    expect((await getJudgeState(app.kernel!.database)).suspended).toBe(false);
  });
});
