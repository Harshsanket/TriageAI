/**
 * Password hashing (FR-11.1): argon2id at the OWASP baseline parameters.
 * Parameters live here (not in config) so every stored hash stays verifiable.
 */
import { Algorithm, hash, verify } from '@node-rs/argon2';

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, OPTIONS);
  } catch {
    return false;
  }
}
