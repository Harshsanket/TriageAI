/**
 * Node ↔ Python contract test (Phase 3). Runs against a live ai-service:
 *   RUN_AI_CONTRACT_TESTS=1 AI_SERVICE_URL=http://localhost:8000 \
 *   pnpm --filter @triageai/api exec vitest run test/ai.contract.test.ts
 *
 * Any drift between the Pydantic models and the Zod DTOs fails here.
 */
import { describe, expect, it } from 'vitest';

import { AiClassifyResponseSchema, AiEmbedResponseSchema } from '@triageai/contracts';

const enabled = process.env.RUN_AI_CONTRACT_TESTS === '1';
const baseUrl = process.env.AI_SERVICE_URL ?? 'http://localhost:8000';

describe.skipIf(!enabled)('ai-service contract', () => {
  it('embeds texts with a stable vector shape (camelCase modelVersion)', async () => {
    const res = await fetch(`${baseUrl}/ai/v1/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts: ['hello world', 'second text'] }),
    });
    expect(res.status).toBe(200);
    const parsed = AiEmbedResponseSchema.parse(await res.json());
    expect(parsed.vectors).toHaveLength(2);
    expect(parsed.vectors[0]).toHaveLength(parsed.vectors[1]!.length);
    const norm = parsed.vectors[0]!.reduce((sum, value) => sum + value * value, 0);
    expect(norm).toBeCloseTo(1, 2);
  }, 60_000);

  it('classifies a billing ticket and matches the classify contract', async () => {
    const res = await fetch(`${baseUrl}/ai/v1/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'I was charged twice for my subscription this month' }),
    });
    expect(res.status).toBe(200);
    const parsed = AiClassifyResponseSchema.parse(await res.json());
    expect(parsed.method).toBe('zero-shot');
    expect(parsed.scores.length).toBeGreaterThan(3);
    expect(typeof parsed.modelVersion).toBe('string');
  }, 60_000);

  it('rejects empty text with a 422', async () => {
    const res = await fetch(`${baseUrl}/ai/v1/classify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(422);
  });
});

// Host-side capability adapters must satisfy the same wire contract.
import { HttpClassifier, HttpEmbedder } from '../src/services/capabilities.js';

describe.skipIf(!enabled)('capability adapters (host)', () => {
  it('embedder + classifier adapters parse the live service responses', async () => {
    const embedder = new HttpEmbedder(baseUrl);
    const embedded = await embedder.embed(['refund my subscription']);
    expect(embedded.vectors).toHaveLength(1);
    expect(embedded.modelVersion.length).toBeGreaterThan(0);

    const classifier = new HttpClassifier(baseUrl);
    const classified = await classifier.classify(
      'I was charged twice for my subscription this month',
    );
    expect(['billing', 'refund_dispute', 'unknown']).toContain(classified.category);
    expect(classified.confidence).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
