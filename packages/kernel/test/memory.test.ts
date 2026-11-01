import { describe, expect, it } from 'vitest';

import { validateMemoryInput, volatileFieldTool } from '../src/memory/index.js';

describe('memory validation (phase 16)', () => {
  it('accepts a short sourced fact', () => {
    expect(() =>
      validateMemoryInput({
        text: 'Refunds take five days.',
        sourceRefs: ['ticket:1'],
        kind: 'fact',
      }),
    ).not.toThrow();
  });

  it('rejects long entries, missing sources, volatile fields and dated lessons', () => {
    expect(() =>
      validateMemoryInput({ text: 'x'.repeat(301), sourceRefs: ['s'], kind: 'fact' }),
    ).toThrow(/300/);
    expect(() => validateMemoryInput({ text: 'ok fact', sourceRefs: [], kind: 'fact' })).toThrow(
      /source/,
    );
    expect(() =>
      validateMemoryInput({
        text: 'The customer plan is enterprise',
        sourceRefs: ['s'],
        kind: 'fact',
      }),
    ).toThrow(/crm.get_deal/);
    expect(volatileFieldTool('ticket status is open')).toBe('support.get_ticket');
    expect(() =>
      validateMemoryInput({
        text: 'On 4 March the banner covered the button; always check layout changes.',
        sourceRefs: ['s'],
        kind: 'lesson',
      }),
    ).toThrow(/general rule/);
  });
});
