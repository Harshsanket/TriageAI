import { describe, expect, it } from 'vitest';

import { ErrorCategorySchema, ErrorEnvelopeSchema } from '../src/errors.js';

const envelope = {
  type: 'https://triageai.dev/errors/support.TICKET_NOT_FOUND',
  title: 'support.TICKET_NOT_FOUND',
  status: 404,
  code: 'support.TICKET_NOT_FOUND',
  category: 'not_found',
  retryable: false,
  userMessage: 'That ticket does not exist.',
  detail: 'ticket 01J... not found',
  correlationId: 'req-1',
};

describe('error envelope contract (phase 10c)', () => {
  it('accepts the canonical envelope', () => {
    expect(ErrorEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('accepts the full category set', () => {
    for (const category of ErrorCategorySchema.options) {
      expect(ErrorEnvelopeSchema.safeParse({ ...envelope, category }).success).toBe(true);
    }
  });

  it('requires category, retryable and a correlation id', () => {
    for (const field of ['category', 'retryable', 'correlationId'] as const) {
      const { [field]: _removed, ...rest } = envelope;
      expect(ErrorEnvelopeSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('rejects invalid status, retry-after and category values', () => {
    expect(ErrorEnvelopeSchema.safeParse({ ...envelope, status: 200 }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ ...envelope, retryAfterMs: -1 }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ ...envelope, category: 'oops' }).success).toBe(false);
  });
});
