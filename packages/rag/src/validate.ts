/**
 * Composable deterministic validation checks (Phase 5).
 *
 * Every check is a pure function over the generated output + its sources so a
 * module (or the host adapter) can add/remove/replace checks independently.
 * Deterministic only: a model's self-assessment is never trusted (ADR-0002).
 * Two consumers: runtime KB flows (`ai.validate`) and doc-assistant.
 */
import { DEFAULT_GROUNDING_THRESHOLD, assessAnswer } from './grounding.js';

export interface ValidationSource {
  ref: string;
  text: string;
}

export interface ValidationRequest {
  text: string;
  sources?: ValidationSource[];
  question?: string;
  citations?: string[];
}

export interface ValidationPolicy {
  /** Minimum content-word coverage against the sources. */
  groundingThreshold?: number;
  /** Require at least one citation marker when sources are present. */
  requireCitation?: boolean;
  minChars?: number;
  maxChars?: number;
  /** `fail` (default) rejects outputs containing PII; `ignore` skips the check. */
  pii?: 'fail' | 'ignore';
  /** Regex strings (no flags) that must not appear in the output. */
  forbiddenPatterns?: string[];
  /** Extra regex strings (no flags) treated as prompt-injection markers. */
  injectionPatterns?: string[];
}

export interface ValidationCheckResult {
  checkId: string;
  passed: boolean;
  reasons: string[];
}

export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheckResult[];
}

export const DEFAULT_INJECTION_PATTERNS: string[] = [
  'ignore\\s+(all\\s+)?(previous\\s+|prior\\s+|the\\s+)?(instructions|rules)',
  'disregard\\s+(the\\s+)?(previous\\s+|above\\s+)?instructions',
  'you\\s+are\\s+now\\s+(a|an|the)\\b',
  'reveal\\s+(the\\s+)?system\\s+prompt',
  'print\\s+(the\\s+)?system\\s+prompt',
];

const PII_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  { kind: 'credit_card', pattern: /\b(?:\d[ -]*?){13,19}\b/ },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { kind: 'phone', pattern: /(?:\+\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/ },
];

function compile(patterns: string[]): RegExp[] {
  return patterns.map((source) => {
    try {
      return new RegExp(source, 'i');
    } catch (err) {
      throw new Error(`invalid validation pattern "${source}": ${(err as Error).message}`);
    }
  });
}

export function matchPatterns(text: string, patterns: string[]): string[] {
  return compile(patterns)
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);
}

export interface RedactionResult {
  text: string;
  redactions: Record<string, number>;
}

/** Deterministic PII redaction for the `redact` policy (counts per kind). */
export function redactPii(text: string): RedactionResult {
  let output = text;
  const redactions: Record<string, number> = {};
  for (const { kind, pattern } of PII_PATTERNS) {
    const global = new RegExp(pattern.source, 'gi');
    const matches = output.match(global);
    if (!matches || matches.length === 0) continue;
    redactions[kind] = (redactions[kind] ?? 0) + matches.length;
    output = output.replace(global, `[REDACTED:${kind}]`);
  }
  return { text: output, redactions };
}

export function formatCheck(
  request: ValidationRequest,
  policy: ValidationPolicy,
): ValidationCheckResult {
  const reasons: string[] = [];
  const text = request.text.trim();
  if (!text) reasons.push('empty_answer');
  const min = policy.minChars ?? 1;
  const max = policy.maxChars;
  if (text.length < min) reasons.push(`too_short:${text.length}<${min}`);
  if (max !== undefined && text.length > max) reasons.push(`too_long:${text.length}>${max}`);
  if (/<<<SOURCE|<<<END SOURCE|>>>/.test(text)) reasons.push('source_marker_leak');
  return { checkId: 'format', passed: reasons.length === 0, reasons };
}

export function groundingCheck(
  request: ValidationRequest,
  policy: ValidationPolicy,
): ValidationCheckResult {
  const sources = request.sources ?? [];
  if (sources.length === 0) {
    return { checkId: 'grounding', passed: false, reasons: ['no_sources'] };
  }
  const assessment = assessAnswer(
    request.text,
    sources,
    policy.groundingThreshold ?? DEFAULT_GROUNDING_THRESHOLD,
  );
  return {
    checkId: 'grounding',
    passed: assessment.grounded,
    reasons: assessment.grounded
      ? []
      : [`coverage:${assessment.coverage.toFixed(4)}<${assessment.threshold}`],
  };
}

export function citationCheck(
  request: ValidationRequest,
  policy: ValidationPolicy,
): ValidationCheckResult {
  const sources = request.sources ?? [];
  if (!policy.requireCitation || sources.length === 0) {
    return { checkId: 'citation', passed: true, reasons: [] };
  }
  const cited = sources.some((source) => request.text.includes(`[${source.ref}]`));
  return { checkId: 'citation', passed: cited, reasons: cited ? [] : ['missing_citation'] };
}

export function injectionCheck(
  request: ValidationRequest,
  policy: ValidationPolicy,
): ValidationCheckResult {
  const patterns = [...DEFAULT_INJECTION_PATTERNS, ...(policy.injectionPatterns ?? [])];
  const reasons: string[] = [];
  const scope: Array<[string, string | undefined]> = [
    ['output', request.text],
    ['question', request.question],
  ];
  for (const [where, text] of scope) {
    if (!text) continue;
    for (const match of matchPatterns(text, patterns)) {
      reasons.push(`injection_${where}:${match}`);
    }
  }
  return { checkId: 'injection', passed: reasons.length === 0, reasons };
}

export function piiCheck(
  request: ValidationRequest,
  policy: ValidationPolicy,
): ValidationCheckResult {
  if ((policy.pii ?? 'fail') === 'ignore') {
    return { checkId: 'pii', passed: true, reasons: [] };
  }
  // Quoting a contact address that exists in the retrieved sources is grounded
  // behavior, not a leak. Only PII the model introduced itself fails the check.
  const sourceText = (request.sources ?? []).map((source) => source.text).join('\n');
  const reasons: string[] = [];
  for (const { kind, pattern } of PII_PATTERNS) {
    const match = request.text.match(pattern);
    if (!match) continue;
    if (sourceText.includes(match[0])) continue;
    reasons.push(`pii_${kind}`);
  }
  return { checkId: 'pii', passed: reasons.length === 0, reasons };
}

export function forbiddenCheck(
  request: ValidationRequest,
  policy: ValidationPolicy,
): ValidationCheckResult {
  const matches = matchPatterns(request.text, policy.forbiddenPatterns ?? []);
  return {
    checkId: 'forbidden_topic',
    passed: matches.length === 0,
    reasons: matches.map((match) => `forbidden:${match}`),
  };
}

export type ValidationCheck = (
  request: ValidationRequest,
  policy: ValidationPolicy,
) => ValidationCheckResult;

/** Default stack; callers may pass their own list to add/remove/replace checks. */
export const DEFAULT_CHECKS: ValidationCheck[] = [
  formatCheck,
  groundingCheck,
  citationCheck,
  injectionCheck,
  piiCheck,
  forbiddenCheck,
];

export function runValidation(
  request: ValidationRequest,
  policy: ValidationPolicy = {},
  checks: ValidationCheck[] = DEFAULT_CHECKS,
): ValidationReport {
  const results = checks.map((check) => check(request, policy));
  return { passed: results.every((check) => check.passed), checks: results };
}
