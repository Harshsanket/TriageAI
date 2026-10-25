/**
 * Deterministic priority + team triage (Phase 7).
 *
 * Configuration is module-local: signal substrings per priority code and team
 * mappings by category/priority. Missing signals use the configured fallback
 * (or are ambiguous when it is null); unmapped/conflicting teams are always
 * *ambiguous* and must go to human review — the module never invents a team id.
 */
import type { TicketPriorityCode } from '@triageai/contracts';

export const PRIORITY_CODES: TicketPriorityCode[] = ['P0', 'P1', 'P2', 'P3'];

export interface PrioritySignals {
  P0: string[];
  P1: string[];
  P2: string[];
  P3: string[];
}

export interface TeamMapping {
  teamId: string;
  categories: string[];
  priorities?: TicketPriorityCode[];
}

export interface PriorityMatch {
  priorityCode: TicketPriorityCode | null;
  ambiguous: boolean;
  reasons: string[];
  matchedLevels: TicketPriorityCode[];
}

export interface TeamMatch {
  teamId: string | null;
  ambiguous: boolean;
  reasons: string[];
  candidates: string[];
}

export const DEFAULT_PRIORITY_SIGNALS: PrioritySignals = {
  P0: [
    'outage',
    'data loss',
    'hacked',
    'unauthorized access',
    'unauthorised access',
    'breach',
    'ransomware',
    'production down',
    'everyone is down',
  ],
  P1: [
    'crash',
    'charged twice',
    'vulnerability',
    'cannot access',
    "can't log in",
    'locked out',
    'urgent',
    'privilege escalation',
  ],
  P2: ['error', 'bug', 'broken', 'failed', 'stuck', 'timeout', 'not working', 'wrong'],
  P3: ['question', 'how do i', 'feature', 'invoice', 'refund', 'password reset', 'help'],
};

export const DEFAULT_TEAM_MAPPINGS: TeamMapping[] = [
  { teamId: 'human-review', categories: ['security', 'unknown'] },
  { teamId: 'billing', categories: ['billing', 'refund_dispute'] },
  { teamId: 'engineering', categories: ['bug_report'] },
  { teamId: 'accounts', categories: ['account'] },
  { teamId: 'support', categories: ['known_troubleshooting', 'general_question'] },
  { teamId: 'product', categories: ['feature_question'] },
];

/**
 * Match the configured signal substrings. Multiple levels resolve by severity
 * order (P0 most severe); zero levels use the fallback or become ambiguous when
 * the strict profile disables it.
 */
export function matchPriority(
  text: string,
  signals: PrioritySignals,
  fallback: TicketPriorityCode | null = 'P3',
): PriorityMatch {
  const haystack = text.toLowerCase();
  const matchedLevels = PRIORITY_CODES.filter((code) =>
    signals[code].some((signal) => signal.length > 0 && haystack.includes(signal.toLowerCase())),
  );
  if (matchedLevels.length === 0) {
    if (fallback) {
      return {
        priorityCode: fallback,
        ambiguous: false,
        reasons: ['priority_signal_missing', `priority_signal_default:${fallback}`],
        matchedLevels,
      };
    }
    return {
      priorityCode: null,
      ambiguous: true,
      reasons: ['priority_signal_missing'],
      matchedLevels,
    };
  }
  if (matchedLevels.length > 1) {
    // Multiple signals are resolved by the configured severity order (P0 is
    // most severe). This is policy, not fabrication: ambiguity is reserved for
    // *no* signal or an unmapped team.
    const priorityCode = matchedLevels[0] as TicketPriorityCode;
    return {
      priorityCode,
      ambiguous: false,
      reasons: [
        `priority_signal_multiple:${matchedLevels.join(',')}`,
        `priority_signal:${priorityCode}`,
      ],
      matchedLevels,
    };
  }
  return {
    priorityCode: matchedLevels[0] as TicketPriorityCode,
    ambiguous: false,
    reasons: [`priority_signal:${matchedLevels[0]}`],
    matchedLevels,
  };
}

/** Map a category/priority to one configured team. Ambiguity is explicit. */
export function mapTeam(
  category: string | null,
  priorityCode: TicketPriorityCode | null,
  mappings: TeamMapping[],
): TeamMatch {
  const candidates = mappings.filter(
    (mapping) =>
      Boolean(category && mapping.categories.includes(category)) ||
      Boolean(priorityCode && mapping.priorities?.includes(priorityCode)),
  );
  const teamIds = [...new Set(candidates.map((mapping) => mapping.teamId))];
  if (teamIds.length === 0) {
    return {
      teamId: null,
      ambiguous: true,
      reasons: ['team_mapping_missing'],
      candidates: [],
    };
  }
  if (teamIds.length > 1) {
    return {
      teamId: null,
      ambiguous: true,
      reasons: [`team_mapping_conflict:${teamIds.join(',')}`],
      candidates: teamIds,
    };
  }
  return {
    teamId: teamIds[0] as string,
    ambiguous: false,
    reasons: [`team_mapping:${teamIds[0]}`],
    candidates: teamIds,
  };
}

export function policyTeamIds(mappings: TeamMapping[]): string[] {
  return [...new Set(mappings.map((mapping) => mapping.teamId))].sort();
}
