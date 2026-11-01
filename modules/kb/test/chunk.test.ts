import { describe, expect, it } from 'vitest';

import { chunkDocument, chunkText } from '@triageai/rag';

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

  it('keeps heading paths and code blocks intact', () => {
    const text = [
      '# Billing',
      '',
      'Refunds are explained here.',
      '',
      '## Steps',
      '',
      '```',
      'step one',
      'step two',
      '```',
      '',
      '- list item',
    ].join('\n');
    const chunks = chunkDocument(text, 200);
    expect(chunks.some((chunk) => chunk.headingPath === 'Billing')).toBe(true);
    expect(chunks.some((chunk) => chunk.headingPath === 'Billing › Steps')).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join('\n')).toContain('step one');
    expect(chunks.length).toBeGreaterThan(0);
  });
});
