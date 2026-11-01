import { describe, expect, it } from 'vitest';

import { classifySend } from '../src/data/sendGate.js';

describe('send gate (phase 18.8)', () => {
  it('sends public and internal content, redacting hosted/internal', () => {
    expect(classifySend({ sensitivity: 'public', hosted: true })).toMatchObject({
      decision: 'sent',
    });
    expect(classifySend({ sensitivity: 'internal', hosted: false })).toMatchObject({
      decision: 'sent',
    });
    expect(classifySend({ sensitivity: 'internal', hosted: true })).toMatchObject({
      decision: 'redacted',
    });
  });

  it('never sends secrets and withholds restricted from hosted models', () => {
    expect(classifySend({ sensitivity: 'secret', hosted: false })).toMatchObject({
      decision: 'withheld',
      reason: 'secret',
    });
    expect(classifySend({ sensitivity: 'restricted', hosted: true })).toMatchObject({
      decision: 'withheld',
      reason: 'restricted_hosted',
    });
    expect(classifySend({ sensitivity: 'restricted', hosted: false })).toMatchObject({
      decision: 'sent',
    });
  });

  it('honours modelUse and the agent egress ceiling', () => {
    expect(
      classifySend({ sensitivity: 'internal', hosted: true, modelUse: 'local_only' }),
    ).toMatchObject({ decision: 'withheld', reason: 'local_only' });
    expect(
      classifySend({ sensitivity: 'internal', hosted: false, modelUse: 'never' }),
    ).toMatchObject({
      decision: 'withheld',
      reason: 'model_use_never',
    });
    expect(
      classifySend({ sensitivity: 'restricted', hosted: false, egressClass: 'internal' }),
    ).toMatchObject({ decision: 'withheld', reason: 'egress_class_exceeded' });
  });

  it('redacts tagged PII even for local models', () => {
    expect(
      classifySend({ sensitivity: 'public', hosted: false, tags: ['pii:email'] }),
    ).toMatchObject({ decision: 'redacted' });
  });
});
