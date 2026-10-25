/**
 * Secret redaction for logs and admin-facing config views (FR-11.4).
 * Keys are matched case-insensitively; values are replaced, never truncated.
 */
const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|webhook[_-]?url)/i;

export const REDACTED = '[redacted]';

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item);
    }
    return out;
  }
  return value;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}
