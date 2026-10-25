/**
 * Session token primitives. Access tokens are short-lived HS256 JWTs; refresh
 * tokens are opaque random strings whose SHA-256 hash is the only copy stored
 * (a database leak cannot be replayed).
 */
import { createHash, randomBytes } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import { AppError } from '../errors.js';

export type Role = 'customer' | 'agent' | 'admin';

export interface AccessClaims {
  sub: string;
  email: string;
  role: Role;
  sid: string;
}

const ISSUER = 'triageai';
const AUDIENCE = 'triageai-api';

export function createRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function signAccessToken(
  claims: AccessClaims,
  options: { secret: string; ttlSeconds: number },
): Promise<string> {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(claims.sid)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + options.ttlSeconds)
    .sign(new TextEncoder().encode(options.secret));
}

export async function verifyAccessToken(
  token: string,
  options: { secret: string },
): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(options.secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    const role = payload.role;
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.email !== 'string' ||
      typeof payload.jti !== 'string' ||
      (role !== 'customer' && role !== 'agent' && role !== 'admin')
    ) {
      throw new Error('malformed claims');
    }
    return { sub: payload.sub, email: payload.email, role, sid: payload.jti };
  } catch {
    throw new AppError('auth.UNAUTHENTICATED', 'invalid or expired access token', undefined, 401);
  }
}
