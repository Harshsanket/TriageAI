import { describe, expect, it } from 'vitest';

import { chunkText } from '@triageai/rag';

describe('kb chunker', () => {
  it('merges short paragraphs up to the limit', () => {
    const chunks = chunkText('One.\n\nTwo.', 700);
    expect(chunks).toEqual(['One.\n\nTwo.']);
  });

  it('splits oversized text without losing content', () => {
    const paragraph = Array.from({ length: 30 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const chunks = chunkText(paragraph, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 120)).toBe(true);
    expect(chunks.join(' ')).toContain('Sentence number 29');
  });

  it('is deterministic', () => {
    const text = 'A.\n\nB.\n\nC.';
    expect(chunkText(text, 10)).toEqual(chunkText(text, 10));
  });
});
