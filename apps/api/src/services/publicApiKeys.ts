/** Public API key verification for host-owned key surfaces (MCP, tickets). */
import { createHash } from 'node:crypto';

import { AppError, policyBlocked } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

export interface PublicApiKey {
  id: string;
  name: string;
  scopes: string[];
}

export async function verifyPublicApiKey(
  kernel: Kernel,
  authorization: string | undefined,
  requiredScope: string,
): Promise<PublicApiKey> {
  const header = authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    throw new AppError('auth.UNAUTHENTICATED', 'missing API key', undefined, 401, {
      category: 'unauthenticated',
    });
  }
  const hash = createHash('sha256').update(token).digest('hex');
  const rows = await kernel.database.query<{
    id: string;
    name: string;
    scopes: string[];
    revoked_at: string | null;
  }>(
    `SELECT id, name, scopes, revoked_at FROM mod_public_api.public_api_keys WHERE key_hash = $1`,
    [hash],
  );
  const key = rows[0];
  if (!key || key.revoked_at) {
    throw new AppError('auth.UNAUTHENTICATED', 'invalid or revoked API key', undefined, 401, {
      category: 'unauthenticated',
    });
  }
  if (!key.scopes.includes(requiredScope)) {
    throw policyBlocked(`this API key is not allowed to use ${requiredScope}`);
  }
  await kernel.database
    .query(`UPDATE mod_public_api.public_api_keys SET last_used_at = now() WHERE id = $1`, [key.id])
    .catch(() => undefined);
  return { id: key.id, name: key.name, scopes: key.scopes };
}
