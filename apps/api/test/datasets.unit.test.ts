import { describe, expect, it } from 'vitest';

import { hashExample, labelOf, planDataset, stableStringify } from '../src/platform/datasets.js';
import type { BuildableExample } from '../src/platform/datasets.js';

function example(
  id: string,
  label: string,
  createdAt: string,
  overrides: Partial<BuildableExample> = {},
): BuildableExample {
  return {
    id,
    source: 'correction',
    sourceGroup: `run:${id}`,
    label,
    createdAt,
    input: { text: `text-${id}` },
    gold: { category: label },
    provenance: {},
    ...overrides,
  };
}

describe('dataset splitting', () => {
  it('keeps a source run in one split and never duplicates an example', () => {
    const examples = [
      example('a1', 'billing', '2026-01-01T00:00:00Z', { sourceGroup: 'run:A' }),
      example('a2', 'billing', '2026-01-01T00:01:00Z', { sourceGroup: 'run:A' }),
      example('a3', 'billing', '2026-01-02T00:00:00Z'),
      example('a4', 'billing', '2026-01-03T00:00:00Z'),
      example('a5', 'billing', '2026-01-04T00:00:00Z'),
      example('b1', 'security', '2026-01-01T00:00:00Z', { sourceGroup: 'run:B' }),
      example('b2', 'security', '2026-01-01T00:01:00Z', { sourceGroup: 'run:B' }),
      example('b3', 'security', '2026-01-02T00:00:00Z'),
      example('b4', 'security', '2026-01-03T00:00:00Z'),
      example('b5', 'security', '2026-01-04T00:00:00Z'),
    ];
    const plan = planDataset(examples);
    const splitOf = new Map<string, string>();
    for (const split of ['train', 'val', 'test'] as const) {
      for (const id of plan.splits[split]) {
        expect(splitOf.has(id)).toBe(false);
        splitOf.set(id, split);
      }
    }
    expect(splitOf.size).toBe(examples.length);
    expect(splitOf.get('a1')).toBe(splitOf.get('a2'));
    expect(splitOf.get('b1')).toBe(splitOf.get('b2'));
    expect(plan.counts.train).toBeGreaterThan(0);
    expect(plan.counts.val).toBeGreaterThan(0);
    expect(plan.counts.test).toBeGreaterThan(0);
  });

  it('orders each label by time: oldest train, newest test', () => {
    const examples = [
      ...[1, 2, 3, 4, 5].map((day) => example(`a${day}`, 'billing', `2026-01-0${day}T00:00:00Z`)),
    ];
    const plan = planDataset(examples);
    const splitOf = new Map<string, string>();
    for (const split of ['train', 'val', 'test'] as const) {
      for (const id of plan.splits[split]) splitOf.set(id, split);
    }
    expect(splitOf.get('a1')).toBe('train');
    expect(splitOf.get('a5')).toBe('test');
  });

  it('forces identical inputs into one split even across source runs', () => {
    const shared = { text: 'same input' };
    const examples = [
      example('a1', 'billing', '2026-01-01T00:00:00Z', { input: shared }),
      example('a2', 'billing', '2026-01-02T00:00:00Z', { input: shared }),
      example('a3', 'billing', '2026-01-03T00:00:00Z'),
      example('a4', 'billing', '2026-01-04T00:00:00Z'),
      example('a5', 'billing', '2026-01-05T00:00:00Z'),
    ];
    const plan = planDataset(examples);
    const splitOf = new Map<string, string>();
    for (const split of ['train', 'val', 'test'] as const) {
      for (const id of plan.splits[split]) splitOf.set(id, split);
    }
    expect(splitOf.get('a1')).toBe(splitOf.get('a2'));
  });

  it('is deterministic regardless of input order', () => {
    const examples = [
      example('a1', 'billing', '2026-01-01T00:00:00Z'),
      example('a2', 'billing', '2026-01-02T00:00:00Z'),
      example('a3', 'billing', '2026-01-03T00:00:00Z'),
      example('b1', 'security', '2026-01-01T00:00:00Z'),
      example('b2', 'security', '2026-01-02T00:00:00Z'),
      example('b3', 'security', '2026-01-03T00:00:00Z'),
    ];
    const forward = planDataset(examples);
    const reversed = planDataset([...examples].reverse());
    expect(reversed.sha256).toBe(forward.sha256);
    expect(reversed.splits).toEqual(forward.splits);
  });

  it('hashes stable JSON and extracts labels from gold values', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(labelOf({ category: 'billing' })).toBe('billing');
    expect(labelOf({ label: 'security' })).toBe('security');
    expect(labelOf('free text')).toBe('unknown');
    const first = example('x', 'billing', '2026-01-01T00:00:00Z');
    expect(hashExample(first)).toBe(hashExample({ ...first, provenance: {} }));
  });
});
