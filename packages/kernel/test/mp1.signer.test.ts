import { describe, expect, it } from 'vitest';

import { mp1Request } from '../src/mp1/broker.js';
import { Mp1Signer, verifyCoreSignature } from '../src/mp1/signer.js';
import { ReplayCache } from '../src/mp1/replay.js';

describe('MP1 signing and replay protection (ADR-0055 §6)', () => {
  it('verifies a signed envelope and refuses a tampered payload', () => {
    const signer = Mp1Signer.generate('gen-1');
    const envelope = mp1Request({
      op: 'runs.get',
      from: 'core',
      to: 'module:demo',
      schema: 'mp1.runs.get@1',
      payload: { id: 'run-1' },
    });
    const signed = { ...envelope, coreSig: signer.sign(envelope) };
    expect(signer.verify(signed)).toBe(true);
    expect(verifyCoreSignature(signed, signer.publicKeyBase64)).toBe(true);
    const tampered = { ...signed, payload: { id: 'run-2' } };
    expect(signer.verify(tampered)).toBe(false);
    expect(verifyCoreSignature({ ...signed, coreSig: 'AAAA' }, signer.publicKeyBase64)).toBe(false);
  });

  it('remembers an id until its deadline, then forgets it', () => {
    const cache = new ReplayCache();
    const now = Date.parse('2026-01-01T00:00:00Z');
    const envelope = { id: 'msg-1', deadline: '2026-01-01T00:00:30Z' };
    expect(cache.check(envelope, now)).toBe(true);
    expect(cache.check(envelope, now + 1_000)).toBe(false);
    expect(cache.check(envelope, now + 31_000)).toBe(true);
  });
});
