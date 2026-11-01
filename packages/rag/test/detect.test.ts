import { describe, expect, it } from 'vitest';

import { detect, maskPii, scrubSecrets } from '../src/detect.js';

describe('PII/secret detectors (phase 18)', () => {
  it('detects email, phone, card (Luhn) and secrets', () => {
    expect(detect('mail jane@example.com')).toMatchObject({ hasPii: true, tags: ['pii:email'] });
    expect(detect('call 555-123-4567')).toMatchObject({ tags: ['pii:phone'] });
    expect(detect('card 4111 1111 1111 1111')).toMatchObject({ tags: ['pii:payment_card'] });
    expect(detect('card 4111 1111 1111 1112')).toMatchObject({ tags: [] });
    expect(detect('token sk-abcdefghijklmnop')).toMatchObject({
      hasSecret: true,
      sensitivity: 'secret',
    });
    expect(detect('postgres://u:p@db/x')).toMatchObject({ tags: ['secret:connection_string'] });
  });

  it('masks for prompts with placeholders and for logs with redaction', () => {
    const prompt = maskPii('email jane@example.com token sk-abcdefghijklmnop', 'prompt');
    expect(prompt.text).toContain('<PII:EMAIL_1>');
    expect(prompt.text).not.toContain('jane@example.com');
    const log = maskPii('email jane@example.com card 4111111111111111', 'log');
    expect(log.text).toContain('j***@example.com');
    expect(log.text).toContain('1111');
    expect(scrubSecrets('postgres://u:p@db/x')).not.toContain('postgres://');
  });
});
