import { describe, expect, it } from 'vitest';

import { AGENT_COLORS, pickAgentColor, pickAgentName, SetupAnswersSchema } from '../src/index.js';

const NASA = [
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

describe('agent names and colours (phase 20.6)', () => {
  it('picks the next unused NASA name and numbers after the list runs out', () => {
    expect(pickAgentName(NASA, [])).toBe('Voyager');
    expect(pickAgentName(NASA, ['Voyager'])).toBe('Pioneer');
    expect(pickAgentName(NASA, NASA)).toBe('Voyager 2');
    expect(pickAgentName(NASA, [...NASA, 'Voyager 2'])).toBe('Pioneer 2');
  });

  it('skips colours already in use and cycles when all are taken', () => {
    expect(pickAgentColor(AGENT_COLORS, [])).toBe(AGENT_COLORS[0]);
    expect(pickAgentColor(AGENT_COLORS, [AGENT_COLORS[0]])).toBe(AGENT_COLORS[1]);
    expect(pickAgentColor(AGENT_COLORS, AGENT_COLORS)).toBe(AGENT_COLORS[0]);
  });

  it('accepts a named, coloured agent per interface', () => {
    const parsed = SetupAnswersSchema.parse({
      interfaces: ['chatbot', 'ticket-solver'],
      llm: { runtime: 'ollama', model: 'm' },
      agents: [
        { interface: 'chatbot', displayName: 'Voyager', color: '#3b6fd4' },
        { interface: 'ticket-solver', displayName: 'Pioneer', color: '#d9730d' },
      ],
    });
    expect(parsed.agents.map((agent) => agent.displayName)).toEqual(['Voyager', 'Pioneer']);
    expect(() =>
      SetupAnswersSchema.parse({
        interfaces: ['chatbot'],
        llm: { runtime: 'none' },
        agents: [{ interface: 'chatbot', displayName: 'x'.repeat(41), color: '#3b6fd4' }],
      }),
    ).toThrow();
  });
});
