/**
 * Stage-B gate (ADR-0055 §4). Before third-party modules may run in a
 * container, the core must operate a private CA and bind session tokens to
 * certificates. This module owns the hard gate and certificate lifecycle
 * policy; certificate issuance itself is delegated to the deployment's CA
 * material so the kernel carries no X.509 implementation.
 */
import { policyBlocked } from '../errors.js';
import type { ModuleRunMode } from '../types.js';

export interface MtlsPolicy {
  enabled: boolean;
  /** Core CA certificate/key references (paths or secret names). */
  caCertRef?: string;
  caKeyRef?: string;
  certificateTtlHours: number;
}

export const DEFAULT_MTLS_POLICY: MtlsPolicy = {
  enabled: false,
  certificateTtlHours: 24,
};

export function assertThirdPartyContainerAllowed(
  input: { moduleId: string; thirdParty: boolean; runMode: ModuleRunMode },
  policy: MtlsPolicy = DEFAULT_MTLS_POLICY,
): void {
  if (input.thirdParty && input.runMode === 'container' && !policy.enabled) {
    throw policyBlocked(
      `third-party module ${input.moduleId} may not run in a container until Stage-B mTLS is enabled`,
    );
  }
}

export function certificateRenewalDue(expiresAt: Date, now = new Date(), windowHours = 6): boolean {
  return expiresAt.getTime() - now.getTime() <= windowHours * 60 * 60 * 1000;
}
