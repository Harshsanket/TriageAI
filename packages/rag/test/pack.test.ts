import { describe, expect, it } from 'vitest';

import { buildContextPack, routeNeeds } from '../src/pack.js';

const items = [
  {
    ref: 'kb:1',
    source: 'knowledge' as const,
    text: 'a',
    reason: 'top chunk',
    relevance: 0.9,
    tokens: 100,
  },
  {
    ref: 'kb:2',
    source: 'knowledge' as const,
    text: 'b',
    reason: 'second',
    relevance: 0.8,
    tokens: 100,
  },
  {
    ref: 'm:1',
    source: 'memory' as const,
    text: 'c',
    reason: 'preference',
    relevance: 0.8,
    tokens: 50,
  },
  { ref: 'h:1', source: 'history' as const, text: 'd', reason: 'turn', tokens: 40 },
];

describe('context packer (phase 16)', () => {
  it('sends zero extra tokens when the need router says none', () => {
    const pack = buildContextPack({
      coreTokens: 100,
      windowTokens: 1000,
      needs: ['none'],
      needReason: 'formatting',
      items,
    });
    expect(pack.included).toEqual([]);
    expect(pack.tokens.total).toBe(100);
  });

  it('keeps only selected sources and honours ceilings/count caps', () => {
    const pack = buildContextPack({
      coreTokens: 100,
      windowTokens: 1000,
      needs: ['knowledge'],
      needReason: 'question',
      items,
      defaults: { chunks: 1, memories: 5, turns: 4 },
    });
    expect(pack.included.map((item) => item.ref)).toEqual(['kb:1']);
    expect(pack.pointers).toContain('kb:2');
    expect(pack.tokens.retrieved).toBe(100);
    expect(pack.included.every((item) => item.used === false)).toBe(true);
    expect(pack.tokens.total).toBeLessThanOrEqual(1000);
  });

  it('withholds items the send gate blocked', () => {
    const pack = buildContextPack({
      coreTokens: 0,
      windowTokens: 1000,
      needs: ['knowledge'],
      needReason: 'question',
      items: [{ ...items[0]!, send: 'withheld' as const }],
    });
    expect(pack.included).toEqual([]);
    expect(pack.withheld[0]).toMatchObject({ ref: 'kb:1' });
  });

  it('routes follow-ups, memory, activity and factual questions', () => {
    expect(routeNeeds('and the second option?', { hasHistory: true }).needs).toContain('history');
    expect(routeNeeds('what does this user prefer', { hasMemory: true }).needs).toContain('memory');
    expect(routeNeeds('what happened yesterday').needs).toContain('logs');
    expect(routeNeeds('how long do refunds take').needs).toContain('knowledge');
  });
});
