import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRIORITY_SIGNALS,
  DEFAULT_TEAM_MAPPINGS,
  mapTeam,
  matchPriority,
} from '../src/triage.js';

describe('priority matching (phase 7)', () => {
  it('maps one signal level deterministically', () => {
    expect(matchPriority('I was charged twice this month', DEFAULT_PRIORITY_SIGNALS)).toMatchObject(
      {
        priorityCode: 'P1',
        ambiguous: false,
        matchedLevels: ['P1'],
      },
    );
  });

  it('uses the configured fallback priority when no signal matches', () => {
    const match = matchPriority('asdf qwer zxcv', DEFAULT_PRIORITY_SIGNALS);
    expect(match.priorityCode).toBe('P3');
    expect(match.ambiguous).toBe(false);
    expect(match.reasons).toContain('priority_signal_missing');
  });

  it('treats missing signals as ambiguous when the strict profile disables the fallback', () => {
    const match = matchPriority('asdf qwer zxcv', DEFAULT_PRIORITY_SIGNALS, null);
    expect(match.priorityCode).toBeNull();
    expect(match.ambiguous).toBe(true);
    expect(match.reasons).toContain('priority_signal_missing');
  });

  it('resolves multiple levels by the configured severity order', () => {
    const match = matchPriority('the app crashed and shows an error', DEFAULT_PRIORITY_SIGNALS);
    expect(match.priorityCode).toBe('P1');
    expect(match.ambiguous).toBe(false);
    expect(match.reasons[0]).toContain('priority_signal_multiple');
  });
});

describe('team mapping (phase 7)', () => {
  it('maps configured categories to one team', () => {
    expect(mapTeam('billing', 'P1', DEFAULT_TEAM_MAPPINGS)).toMatchObject({
      teamId: 'billing',
      ambiguous: false,
    });
  });

  it('never fabricates a team for an unmapped category', () => {
    const match = mapTeam('something_new', null, DEFAULT_TEAM_MAPPINGS);
    expect(match.teamId).toBeNull();
    expect(match.ambiguous).toBe(true);
    expect(match.reasons).toContain('team_mapping_missing');
  });

  it('flags conflicting team mappings', () => {
    const match = mapTeam('billing', 'P1', [
      { teamId: 'billing', categories: ['billing'] },
      { teamId: 'escalations', categories: [], priorities: ['P1'] },
    ]);
    expect(match.teamId).toBeNull();
    expect(match.ambiguous).toBe(true);
    expect(match.reasons[0]).toContain('team_mapping_conflict');
  });
});
