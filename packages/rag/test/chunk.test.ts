import { describe, expect, it } from 'vitest';

import { chunkByPreset } from '../src/index.js';

const TEXT = [
  '# Refunds',
  '',
  'Refunds are processed within five business days. Contact billing for questions.',
  '',
  '## Exceptions',
  '',
  'Gift cards are not refundable. Damaged items are replaced instead.',
].join('\n');

describe('chunk presets', () => {
  it('keeps headings with structure-aware strategies', () => {
    const chunks = chunkByPreset(TEXT, 'structure-700');
    expect(chunks.map((chunk) => chunk.headingPath)).toContain('Refunds');
    expect(chunks.map((chunk) => chunk.headingPath)).toContain('Refunds › Exceptions');
    expect(chunks.every((chunk) => chunk.text.length <= 700)).toBe(true);
  });

  it('uses a larger window for structure-1200', () => {
    const long = `${TEXT}\n\n${'More detail. '.repeat(120)}`;
    const small = chunkByPreset(long, 'structure-700');
    const large = chunkByPreset(long, 'structure-1200');
    expect(large.length).toBeLessThan(small.length);
    expect(large.reduce((sum, chunk) => sum + chunk.text.length, 0)).toBeGreaterThan(0);
  });

  it('splits fixed windows with overlap and no heading path', () => {
    const chunks = chunkByPreset('x'.repeat(2_500), 'fixed-1000');
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.headingPath === '')).toBe(true);
    expect(chunks[0]?.text).toHaveLength(1_000);
    expect(chunks[1]?.text).toHaveLength(1_000);
    expect(chunks[2]?.text).toHaveLength(800);
  });

  it('falls back to the default for an unknown preset', () => {
    const chunks = chunkByPreset(TEXT, 'not-a-preset');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.headingPath).toBe('Refunds');
  });
});
