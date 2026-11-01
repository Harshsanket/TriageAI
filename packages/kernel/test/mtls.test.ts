import { describe, expect, it } from 'vitest';

import {
  assertThirdPartyContainerAllowed,
  certificateRenewalDue,
  DEFAULT_MTLS_POLICY,
} from '../src/mp1/mtls.js';

describe('Stage-B mTLS gate (ADR-0055 §4)', () => {
  it('refuses third-party container modules until mTLS is enabled', () => {
    expect(() =>
      assertThirdPartyContainerAllowed(
        { moduleId: 'third-party', thirdParty: true, runMode: 'container' },
        DEFAULT_MTLS_POLICY,
      ),
    ).toThrow(/Stage-B mTLS/);
    expect(() =>
      assertThirdPartyContainerAllowed(
        { moduleId: 'third-party', thirdParty: true, runMode: 'container' },
        { ...DEFAULT_MTLS_POLICY, enabled: true },
      ),
    ).not.toThrow();
    expect(() =>
      assertThirdPartyContainerAllowed(
        { moduleId: 'first-party', thirdParty: false, runMode: 'container' },
        DEFAULT_MTLS_POLICY,
      ),
    ).not.toThrow();
  });

  it('schedules renewal before a 24-hour certificate expires', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(certificateRenewalDue(new Date('2026-01-01T05:00:00Z'), now)).toBe(true);
    expect(certificateRenewalDue(new Date('2026-01-02T05:00:00Z'), now)).toBe(false);
  });
});
