import { describe, expect, it } from 'vitest';

import {
  buildChatContext,
  chatTokenBudget,
  estimateTokens,
  type ChatContextItem,
} from '../src/pack.js';

const item = (ref: string, text: string): ChatContextItem => ({
  ref,
  kind: 'turn',
  text,
  tokens: estimateTokens(text),
});

describe('chat budget and context assembly', () => {
  it('computes a budget from the window, output reserve, sources and safety', () => {
    const budget = chatTokenBudget({
      contextWindow: 8192,
      maxOutputTokens: 384,
      retrievedReserve: 1400,
    });
    expect(budget.available).toBe(8192 - 384 - 1400 - Math.ceil(8192 * 0.05));
    expect(budget.highWaterPercent).toBeCloseTo(0.825);
    expect(budget.highWaterTokens).toBeLessThan(budget.available);
  });

  it('clamps the high-water mark to the 80–85% band', () => {
    expect(
      chatTokenBudget({ contextWindow: 4096, maxOutputTokens: 64, highWaterPercent: 0.2 })
        .highWaterPercent,
    ).toBe(0.8);
    expect(
      chatTokenBudget({ contextWindow: 4096, maxOutputTokens: 64, highWaterPercent: 0.99 })
        .highWaterPercent,
    ).toBe(0.85);
  });

  it('orders summary, pinned facts and recent turns and keeps the newest turn', () => {
    const recent = [
      item('m1', 'old turn '.repeat(50)),
      item('m2', 'middle '.repeat(50)),
      item('m3', 'newest '.repeat(20)),
    ];
    const context = buildChatContext({
      summary: 'Facts: billing is open.',
      pinned: [{ ref: 'skill:x@1', kind: 'pinned', text: 'Answer in bullets.', tokens: 10 }],
      recent,
      budget: chatTokenBudget({ contextWindow: 8192, maxOutputTokens: 128, retrievedReserve: 0 }),
    });
    expect(context.text.indexOf('Session summary')).toBeLessThan(
      context.text.indexOf('Known facts'),
    );
    expect(context.text.indexOf('Known facts')).toBeLessThan(
      context.text.indexOf('Recent conversation'),
    );
    expect(context.included.some((entry) => entry.ref === 'm3')).toBe(true);
    expect(context.tokens.percent).toBeGreaterThan(0);
  });

  it('drops the oldest turns first when the window is small', () => {
    const context = buildChatContext({
      summary: null,
      recent: [item('old', 'o'.repeat(4000)), item('new', 'n'.repeat(40))],
      budget: chatTokenBudget({ contextWindow: 1200, maxOutputTokens: 300, retrievedReserve: 100 }),
    });
    expect(context.dropped).toContain('old');
    expect(context.included.some((entry) => entry.ref === 'new')).toBe(true);
  });

  it('estimates tokens conservatively and never zero for text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBeGreaterThan(1);
  });
});
