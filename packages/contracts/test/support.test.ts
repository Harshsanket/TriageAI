import { describe, expect, it } from 'vitest';

import {
  AutoReplyPolicyDtoSchema,
  AutoReplyPolicyUpdateSchema,
  TicketConfirmationRequestSchema,
} from '../src/index.js';

describe('support contracts (phase 5)', () => {
  it('parses an auto-reply policy summary', () => {
    const policy = AutoReplyPolicyDtoSchema.parse({
      category: 'known_troubleshooting',
      version: 3,
      enabled: false,
      fallbackPolicy: 'escalate_human',
      collection: 'kb_docs',
      maxAnswerChars: 1200,
      note: null,
      updatedBy: 'admin',
      createdAt: '2026-10-24T00:00:00.000Z',
    });
    expect(policy.version).toBe(3);
  });

  it('rejects unknown fallback policies and invalid limits', () => {
    expect(() =>
      AutoReplyPolicyUpdateSchema.parse({ enabled: true, fallbackPolicy: 'invented' }),
    ).toThrow();
    expect(() => AutoReplyPolicyUpdateSchema.parse({ enabled: true, maxAnswerChars: 0 })).toThrow();
  });

  it('requires an explicit solved boolean on confirmation', () => {
    expect(TicketConfirmationRequestSchema.parse({ solved: false, note: 'more help' })).toEqual({
      solved: false,
      note: 'more help',
    });
    expect(() => TicketConfirmationRequestSchema.parse({ note: 'missing solved' })).toThrow();
  });
});
