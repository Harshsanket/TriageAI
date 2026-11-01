/**
 * Stage-A session tokens (ADR-0055 §4): compact EdDSA JWS, iss=core, aud=mp1,
 * ≤ 15 minutes, generation-bound. Containers present them as bearer tokens on
 * the internal module network; the core verifies before accepting a call.
 */
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

import { ulid } from 'ulid';

import { canonicalJson } from './jcs.js';

export interface SessionTokenClaims {
  iss: 'core';
  sub: string;
  aud: 'mp1';
  gen: string;
  exp: number;
  jti: string;
}

const b64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

export class Mp1SessionIssuer {
  readonly publicKeyBase64: string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    private readonly generation: string,
    private readonly maxTtlMs = 15 * 60_000,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  issue(subject: string, ttlMs = this.maxTtlMs): { token: string; claims: SessionTokenClaims } {
    const claims: SessionTokenClaims = {
      iss: 'core',
      sub: subject,
      aud: 'mp1',
      gen: this.generation,
      exp: Math.floor((Date.now() + Math.min(ttlMs, this.maxTtlMs)) / 1000),
      jti: ulid(),
    };
    const header = b64url(canonicalJson({ alg: 'EdDSA', typ: 'JWT', kid: this.generation }));
    const payload = b64url(canonicalJson(claims));
    const signature = sign(null, Buffer.from(`${header}.${payload}`), this.privateKey);
    return { token: `${header}.${payload}.${b64url(signature)}`, claims };
  }

  verify(token: string, now = Date.now(), generation = this.generation): SessionTokenClaims | null {
    return verifySessionToken(token, this.publicKeyBase64, generation, now);
  }
}

export function verifySessionToken(
  token: string,
  publicKeyBase64: string,
  generation?: string,
  now = Date.now(),
): SessionTokenClaims | null {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) return null;
  try {
    const ok = verify(
      null,
      Buffer.from(`${header}.${payload}`),
      { key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' },
      Buffer.from(signature, 'base64url'),
    );
    if (!ok) return null;
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as SessionTokenClaims;
    if (claims.iss !== 'core' || claims.aud !== 'mp1') return null;
    if (generation && claims.gen !== generation) return null;
    if (claims.exp * 1000 < now) return null;
    return claims;
  } catch {
    return null;
  }
}
