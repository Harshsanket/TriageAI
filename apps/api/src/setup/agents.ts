/**
 * Agent naming and colours (Phase 20.6, ADR-0053). Names are data in
 * `config/agent-names.json`; colours come from the shared categorical palette.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AGENT_COLORS,
  pickAgentColor,
  pickAgentName,
  type AgentPreference,
} from '@triageai/contracts';

/** One agent is offered per interface; later Phase-16 agents use the same defaults. */
export const AGENT_FOR_INTERFACE: Record<string, string> = {
  chatbot: 'chat',
  'ticket-solver': 'support',
  'doc-assistant': 'doc-assistant',
  'notifications-github': 'github',
  'notifications-slack': 'slack',
  emailer: 'emailer',
  'public-api': 'public-api',
};

const FALLBACK_NAMES = [
  'Voyager',
  'Pioneer',
  'Cassini',
  'Juno',
  'Galileo',
  'Magellan',
  'Kepler',
  'Dawn',
  'Messenger',
  'Viking',
  'Mariner',
  'Odyssey',
  'Perseverance',
  'Curiosity',
  'Spirit',
  'Opportunity',
  'New Horizons',
  'Lunar Prospector',
  'Stardust',
  'Deep Impact',
  'Parker',
  'Psyche',
  'Lucy',
  'Europa Clipper',
];

export function loadAgentNames(): string[] {
  const candidates = [
    resolve(process.cwd(), 'config/agent-names.json'),
    resolve(process.cwd(), '../../config/agent-names.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(readFileSync(candidate, 'utf8')) as { names?: unknown };
      if (Array.isArray(raw.names)) {
        const names = raw.names.filter(
          (name): name is string => typeof name === 'string' && name.trim().length > 0,
        );
        if (names.length > 0) return names;
      }
    } catch {
      // try the next candidate
    }
  }
  return FALLBACK_NAMES;
}

export function agentDefaults(
  interfaces: string[],
  existingNames: string[] = [],
  usedColors: string[] = [],
): AgentPreference[] {
  const names = loadAgentNames();
  const used = new Set(existingNames.map((name) => name.toLowerCase()));
  const colors = new Set(usedColors.map((color) => color.toLowerCase()));
  const agents: AgentPreference[] = [];
  for (const key of interfaces) {
    const name = pickAgentName(names, used);
    used.add(name.toLowerCase());
    const color = pickAgentColor(AGENT_COLORS, colors);
    colors.add(color.toLowerCase());
    agents.push({ interface: key, displayName: name, color });
  }
  return agents;
}
