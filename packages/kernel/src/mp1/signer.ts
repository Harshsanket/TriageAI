/**
 * Core signing (ADR-0055 §6): ed25519 over JCS of the envelope minus `coreSig`.
 * A key is generated per kernel generation; receivers verify before they trust
 * anything the core forwarded.
 */
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

import type { Mp1Envelope } from '@triageai/contracts';

import { canonicalJson } from './jcs.js';

export class Mp1Signer {
  readonly publicKeyBase64: string;

  constructor(
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
    /** Kernel generation / key id; rotates on restart. */
    readonly keyId: string,
  ) {
    this.publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  static generate(keyId = `core-${Date.now()}`): Mp1Signer {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return new Mp1Signer(privateKey, publicKey, keyId);
  }

  sign(envelope: Mp1Envelope): string {
    const { coreSig: _ignored, ...rest } = envelope;
    void _ignored;
    return sign(null, Buffer.from(canonicalJson(rest), 'utf8'), this.privateKey).toString('base64');
  }

  verify(envelope: Mp1Envelope, publicKeyBase64 = this.publicKeyBase64): boolean {
    return verifyCoreSignature(envelope, publicKeyBase64);
  }
}

/** Standalone verifier used by module SDKs/containers. */
export function verifyCoreSignature(envelope: Mp1Envelope, publicKeyBase64: string): boolean {
  if (!envelope.coreSig) return false;
  try {
    const { coreSig, ...rest } = envelope;
    void coreSig;
    return verify(
      null,
      Buffer.from(canonicalJson(rest), 'utf8'),
      { key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' },
      Buffer.from(envelope.coreSig, 'base64'),
    );
  } catch {
    return false;
  }
}
