import { describe, expect, it } from 'vitest';

import { classifyLesson, validateMemoryInput, volatileFieldTool } from '../src/memory/index.js';

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

  it('requires a registered read tool and a live ref for a volatile field', () => {
    const text = 'The customer plan is enterprise';
    const readDeal = {
      get: (name: string) => (name === 'crm.get_deal' ? { access: 'read' } : undefined),
    };
    expect(() =>
      validateMemoryInput({ text, sourceRefs: ['s'], kind: 'fact' }, { liveTools: readDeal }),
    ).toThrow(/crm.get_deal/);
    expect(() =>
      validateMemoryInput(
        { text, sourceRefs: ['s'], kind: 'fact' },
        { liveTools: { get: () => undefined } },
      ),
    ).toThrow(/not registered/);
    expect(() =>
      validateMemoryInput(
        { text, sourceRefs: ['s'], kind: 'fact' },
        { liveTools: { get: () => ({ access: 'write' }) } },
      ),
    ).toThrow(/not a read tool/);
    expect(() =>
      validateMemoryInput(
        { text, sourceRefs: ['s'], kind: 'fact' },
        { liveTools: readDeal, liveSourceRefs: ['tool:other:1'] },
      ),
    ).toThrow(/live read result/);
    expect(() =>
      validateMemoryInput(
        { text, sourceRefs: ['s'], kind: 'fact' },
        { liveTools: readDeal, liveSourceRefs: ['tool:crm.get_deal:deal-1'] },
      ),
    ).toThrow(/crm.get_deal/);
  });

  it('classifies incidents separately from principles', () => {
    expect(classifyLesson('On 4 March the banner covered the button.')).toBe('incident');
    expect(classifyLesson('2026-03-04 deploy broke the banner.')).toBe('incident');
    expect(classifyLesson('Ticket 4821 exposed a missing permission check.')).toBe('incident');
    expect(
      classifyLesson('After ticket 4821, always verify permissions before enabling a tool.'),
    ).toBe('principle');
    expect(
      classifyLesson('After any layout change, check that no interactive element is covered.'),
    ).toBe('principle');
    expect(() =>
      validateMemoryInput({
        text: 'Ticket 4821 exposed a missing permission check.',
        sourceRefs: ['ticket:4821'],
        kind: 'lesson',
      }),
    ).toThrow(/general rule/);
  });

  it('rejects secrets, empty refs and out-of-range confidence', () => {
    expect(() =>
      validateMemoryInput({
        text: 'The key is sk-abcdefghijklmnop',
        sourceRefs: ['s'],
        kind: 'fact',
      }),
    ).toThrow(/secret/);
    expect(() =>
      validateMemoryInput({ text: 'A sourced fact.', sourceRefs: [''], kind: 'fact' }),
    ).toThrow(/non-empty/);
    expect(() =>
      validateMemoryInput({
        text: 'A sourced fact.',
        sourceRefs: ['s'],
        kind: 'fact',
        confidence: 1.2,
      }),
    ).toThrow(/confidence/);
  });
});
