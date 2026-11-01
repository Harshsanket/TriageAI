/** Tamper-evident audit chain (Phase 18.5): every row hashes the previous one. */
import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function auditHash(input: {
  prevHash: string | null;
  actor: string | null;
  action: string;
  subject: string | null;
  payload: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          prevHash: input.prevHash,
          actor: input.actor,
          action: input.action,
          subject: input.subject,
          payload: input.payload ?? {},
        }),
      ),
    )
    .digest('hex');
}
