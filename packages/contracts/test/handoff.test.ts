import { describe, expect, it } from 'vitest';

import { HandoffSchema, trimHandoff } from '../src/handoff.js';

const handoff = HandoffSchema.parse({
  id: 'h1',
  fromAgentId: 'a',
  toAgentId: 'b',
  goal: 'Finish the task',
  status: 'partial',
  done: [{ what: 'Read the ticket', refs: ['t1'] }],
  decisions: [{ choice: 'use kb', reason: 'grounded', rejected: ['memory'] }],
  facts: [
    { text: 'a'.repeat(2000), ref: 'kb:1' },
    { text: 'b'.repeat(2000), ref: 'kb:2' },
  ],
  openQuestions: [],
  nextSteps: ['write the answer'],
  constraints: [],
  artifacts: [],
  tokenCount: 1200,
});

describe('handoff cap (phase 16)', () => {
  it('validates and trims facts while keeping decisions and next steps', () => {
    const trimmed = trimHandoff(handoff, 300);
    expect(trimmed.facts.length).toBeLessThan(handoff.facts.length);
    expect(trimmed.decisions).toEqual(handoff.decisions);
    expect(trimmed.nextSteps).toEqual(handoff.nextSteps);
    expect(trimmed.tokenCount).toBeLessThanOrEqual(300);
  });

  it('rejects a handoff without an id or goal', () => {
    expect(() => HandoffSchema.parse({ ...handoff, goal: '' })).toThrow();
  });
});
