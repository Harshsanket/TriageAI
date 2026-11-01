/** Watchdog rules (Phase 17.T2): loops, repeated failures, ping-pong handoffs.
 * The watchdog may only pause or escalate; it never edits another agent's state. */
export type WatchdogAction = 'none' | 'pause' | 'escalate';

export interface AgentWatchEvent {
  at: string;
  kind: 'tool_call' | 'handoff' | 'step' | 'error';
  agentId: string;
  tool?: string;
  argsHash?: string;
  workItemId?: string;
  stateHash?: string;
  proofRefs?: string[];
}

export interface WatchdogDecision {
  action: WatchdogAction;
  reason: string;
  agentId?: string;
  workItemId?: string;
}

export function watchdogScan(events: AgentWatchEvent[]): WatchdogDecision {
  // Three identical tool calls in a row.
  let identical = 0;
  let previousKey = '';
  for (const event of events) {
    if (event.kind !== 'tool_call') {
      identical = 0;
      previousKey = '';
      continue;
    }
    const key = `${event.agentId}:${event.tool}:${event.argsHash ?? ''}`;
    identical = key === previousKey ? identical + 1 : 1;
    previousKey = key;
    if (identical >= 3) {
      return {
        action: 'pause',
        reason: 'three_identical_tool_calls',
        agentId: event.agentId,
      };
    }
  }

  // Same work item handed back and forth twice with no state/proof change.
  const handoffs = events.filter((event) => event.kind === 'handoff' && event.workItemId);
  for (let index = 0; index + 3 < handoffs.length; index += 1) {
    const window = handoffs.slice(index, index + 4);
    const item = window[0]?.workItemId;
    if (!item || window.some((event) => event.workItemId !== item)) continue;
    const agents = new Set(window.map((event) => event.agentId));
    const states = new Set(
      window.map((event) => `${event.stateHash ?? ''}|${(event.proofRefs ?? []).join(',')}`),
    );
    if (agents.size >= 2 && states.size === 1) {
      return {
        action: 'escalate',
        reason: 'handoff_ping_pong',
        agentId: window[0]?.agentId,
        workItemId: item,
      };
    }
  }
  return { action: 'none', reason: 'no_rule_fired' };
}
