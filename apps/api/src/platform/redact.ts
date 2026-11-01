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

const SCALAR_SECRETS: RegExp[] = [
  /\bpostgres(?:ql)?:\/\/[^\s'"]+/gi,
  /\b(?:mysql|mongodb(?:\+srv)?|redis):\/\/[^\s'"]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*[^\s,;'"]+/gi,
];

/** Scrub secret-looking values from a free-text message before it leaves the
 * process (10C.T2/T8). Key-based redaction cannot catch a connection string
 * embedded in an error message. */
export function scrubSecrets(text: string): string {
  return SCALAR_SECRETS.reduce((current, pattern) => current.replace(pattern, REDACTED), text);
}
