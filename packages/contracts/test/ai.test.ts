import { describe, expect, it } from 'vitest';

import { AiClassifyResponseSchema, exportJsonSchemas } from '../src/index.js';

describe('ai wire contracts', () => {
  it('are part of the JSON Schema export', () => {
    const schemas = exportJsonSchemas();
    for (const name of [
      'AiEmbedRequest',
      'AiEmbedResponse',
      'AiClassifyRequest',
      'AiCategoryScore',
      'AiClassifyResponse',
    ]) {
      expect(schemas[name]).toBeDefined();
    }
  });

  it('parse a representative classify response', () => {
    const parsed = AiClassifyResponseSchema.parse({
      category: 'billing',
      confidence: 0.87,
      margin: 0.21,
      method: 'zero-shot',
      modelVersion: 'all-MiniLM-L6-v2',
      scores: [
        { category: 'billing', score: 0.87 },
        { category: 'security', score: 0.66 },
      ],
    });
    expect(parsed.category).toBe('billing');
  });

  it('reject out-of-range confidence', () => {
    expect(() =>
      AiClassifyResponseSchema.parse({
        category: 'x',
        confidence: 1.4,
        margin: 0,
        method: 'zero-shot',
        modelVersion: 'm',
        scores: [],
      }),
    ).toThrow();
  });
});
