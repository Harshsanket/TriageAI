/**
 * Write-time PII/secret detectors (Phase 18.8/18.T15).
 *
 * Deterministic only; a detector may raise a record's sensitivity, never lower
 * it. Masking produces stable placeholders for prompts and redacted values for
 * logs (e.g. `j***@example.com`, last 4 digits).
 */
export interface Detection {
  tags: string[];
  sensitivity: 'public' | 'internal' | 'restricted' | 'secret';
  hasPii: boolean;
  hasSecret: boolean;
}

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const PHONE = /(?:\+\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const CARD_CANDIDATE = /\b(?:\d[ -]*?){13,19}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const API_KEY = /\b(?:sk|pk|gh[pousr]|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END [^-]+-----/g;
const CONNECTION = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"]+/gi;
const ASSIGNMENT =
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*[^\s,;'"]+/gi;

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detect(text: string): Detection {
  const tags = new Set<string>();
  let hasSecret = false;
  if (EMAIL.test(text)) tags.add('pii:email');
  EMAIL.lastIndex = 0;
  if (PHONE.test(text)) tags.add('pii:phone');
  PHONE.lastIndex = 0;
  if (SSN.test(text)) tags.add('pii:government_id');
  SSN.lastIndex = 0;
  if (IBAN.test(text)) tags.add('pii:iban');
  IBAN.lastIndex = 0;
  for (const match of text.match(CARD_CANDIDATE) ?? []) {
    if (luhn(match)) tags.add('pii:payment_card');
  }
  for (const [pattern, tag] of [
    [JWT, 'secret:jwt'],
    [API_KEY, 'secret:api_key'],
    [PRIVATE_KEY, 'secret:private_key'],
    [CONNECTION, 'secret:connection_string'],
    [ASSIGNMENT, 'secret:assignment'],
  ] as const) {
    if (pattern.test(text)) {
      tags.add(tag);
      hasSecret = true;
    }
    pattern.lastIndex = 0;
  }
  const hasPii = [...tags].some((tag) => tag.startsWith('pii:'));
  return {
    tags: [...tags],
    sensitivity: hasSecret ? 'secret' : hasPii ? 'restricted' : 'internal',
    hasPii,
    hasSecret,
  };
}

export function maskPii(
  text: string,
  mode: 'log' | 'prompt' = 'prompt',
): {
  text: string;
  redactions: Record<string, number>;
} {
  let output = text;
  const redactions: Record<string, number> = {};
  const replace = (pattern: RegExp, tag: string, replacer: (value: string) => string) => {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
    );
    const matches = output.match(global);
    if (!matches) return;
    redactions[tag] = (redactions[tag] ?? 0) + matches.length;
    let index = 0;
    output = output.replace(global, (value: string) =>
      mode === 'log' ? replacer(value) : `<${tag.toUpperCase()}_${++index}>`,
    );
  };

  replace(EMAIL, 'pii:email', (value) => {
    const [local, domain] = value.split('@');
    return `${local?.slice(0, 1) ?? ''}***@${domain ?? '***'}`;
  });
  replace(PHONE, 'pii:phone', (value) => `***-***-${value.replace(/\D/g, '').slice(-4)}`);
  replace(SSN, 'pii:government_id', () => '***-**-****');
  replace(
    CARD_CANDIDATE,
    'pii:payment_card',
    (value) => `****-****-****-${value.replace(/\D/g, '').slice(-4)}`,
  );
  replace(JWT, 'secret:jwt', () => '[REDACTED:jwt]');
  replace(API_KEY, 'secret:api_key', () => '[REDACTED:api_key]');
  replace(PRIVATE_KEY, 'secret:private_key', () => '[REDACTED:private_key]');
  replace(CONNECTION, 'secret:connection_string', () => '[REDACTED:connection_string]');
  replace(ASSIGNMENT, 'secret:assignment', () => '[REDACTED:secret]');
  return { text: output, redactions };
}

export function scrubSecrets(text: string): string {
  const { text: masked } = maskPii(text, 'log');
  return masked;
}
