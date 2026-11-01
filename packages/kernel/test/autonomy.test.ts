import { describe, expect, it } from 'vitest';

import {
  archiveCutoff,
  buildRunReceipt,
  firstIrreversiblePark,
  nextAutonomy,
  validateAgentDefinition,
  validateRoutine,
} from '../src/operations/autonomy.js';

describe('run receipt + reversibility (phase 15)', () => {
  it('separates completed, sent and waiting and marks usefulness', () => {
    const receipt = buildRunReceipt({
      runId: 'r1',
      calls: [
        { tool: 'kb.search', undo: 'free', status: 'ok' },
        { tool: 'calendar.create_event', undo: 'compensable', status: 'ok' },
        { tool: 'email.send', undo: 'none', status: 'ok' },
        { tool: 'kb.search', undo: 'free', status: 'error' },
      ],
      waiting: [
        {
          approvalId: 'a1',
          tool: 'email.send',
          count: 11,
          summary: 'send 11 replies',
          parked: true,
        },
      ],
    });
    expect(receipt.completed).toEqual([
      { tool: 'kb.search', count: 1 },
      { tool: 'calendar.create_event', count: 1 },
    ]);
    expect(receipt.sent).toEqual([{ tool: 'email.send', count: 1 }]);
    expect(receipt.waiting[0]?.parked).toBe(true);
    expect(receipt.useful).toBe(true);
  });

  it('parks at the first irreversible call', () => {
    expect(
      firstIrreversiblePark([
        { tool: 'kb.search', undo: 'free' },
        { tool: 'email.send', undo: 'none' },
      ]),
    ).toEqual({ parkAt: 1 });
  });
});

describe('flow autonomy (phase 15)', () => {
  it('suggests promotion after 5 clean runs and demotes on a dirty one', () => {
    const promoted = nextAutonomy(
      { level: 'draft', cleanRunStreak: 4, promoteAfter: 5 },
      { clean: true },
    );
    expect(promoted).toMatchObject({
      level: 'draft',
      cleanRunStreak: 5,
      reason: 'promotion_suggested',
    });
    expect(
      nextAutonomy({ level: 'autopilot', cleanRunStreak: 9, promoteAfter: 5 }, { clean: false }),
    ).toMatchObject({ level: 'internal_note', reason: 'dirty_run_demotion' });
    expect(
      nextAutonomy(
        { level: 'autopilot', cleanRunStreak: 0, promoteAfter: 5 },
        { clean: true, targetProduction: true },
      ),
    ).toMatchObject({ level: 'draft', reason: 'production_target' });
  });
});

describe('accountable agents and routines (phase 16/18)', () => {
  it('refuses an agent without job fields or an agentReason', () => {
    expect(validateAgentDefinition({ id: 'a', displayName: 'A' })).toEqual(
      expect.arrayContaining([
        'job.role is required',
        'agentReason is required (or make it a skill instead)',
      ]),
    );
    expect(
      validateAgentDefinition({
        id: 'a',
        displayName: 'A',
        job: { role: 'r', inputs: 'i', output: 'o', doneWhen: 'd', domain: 'dom' },
        agentReason: ['own_schedule'],
        teamSize: 7,
      }),
    ).toEqual(['a team holds at most 6 agents']);
  });

  it('validates routine probes/event filters and archive cutoffs', () => {
    expect(
      validateRoutine({ cron: '*/5 * * * *', modelCalling: true, intervalMinutes: 5 }),
    ).toEqual(['sub-hourly model-calling schedules require a probe']);
    expect(
      validateRoutine({
        cron: '*/5 * * * *',
        modelCalling: true,
        intervalMinutes: 5,
        probe: { kind: 'watermark', read: 'max(updated_at)' },
      }),
    ).toEqual([]);
    expect(validateRoutine({ cron: '* * * * *', eventKind: 'message' })).toEqual([
      'event triggers need a filter narrower than the event kind',
    ]);
    expect(archiveCutoff(new Date('2026-10-30T00:00:00Z')).archiveBefore).toContain('2026-05-03');
  });
});
