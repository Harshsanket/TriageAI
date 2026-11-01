/**
 * Kernel error contract (Phase 10C). Every failure is typed with a stable code,
 * an HTTP status, a category and a retryability flag; the host maps it to the
 * shared `ErrorEnvelope` (packages/contracts/src/errors.ts).
 *
 * The 5th constructor argument is a seam for the factories and for adapters
 * that need to classify a dependency failure precisely. Existing callers keep
 * the positional `(code, message, details?, status?)` shape.
 */
import type { ErrorCategory, ErrorEnvelope } from '@triageai/contracts';

export type { ErrorCategory } from '@triageai/contracts';

const DEFAULT_STATUS: Record<string, number> = {
  'kernel.BOOT_VALIDATION_FAILED': 500,
  'kernel.CONFIG_INVALID': 422,
  'kernel.VERSION_CONFLICT': 409,
  'kernel.CYCLE_DETECTED': 500,
  'kernel.DEPENDENCY_MISSING': 500,
  'kernel.CAPABILITY_MISSING': 500,
  'kernel.MIGRATION_REQUIRED': 500,
  'kernel.MODULE_ALREADY_ENABLED': 409,
  'kernel.NOT_FOUND': 404,
  'kernel.CONFLICT': 409,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
  DEPENDENCY_UNAVAILABLE: 503,
  TIMEOUT: 504,
  RATE_LIMITED: 429,
  BUDGET_EXCEEDED: 429,
  POLICY_BLOCKED: 403,
};

/** Explicit code/reason mappings take precedence over status inference. */
const CATEGORY_BY_CODE: Record<string, ErrorCategory> = {
  VALIDATION_ERROR: 'validation',
  INVALID: 'validation',
  'kernel.CONFIG_INVALID': 'validation',
  'kernel.BOOT_VALIDATION_FAILED': 'internal',
  'kernel.CYCLE_DETECTED': 'internal',
  'kernel.DEPENDENCY_MISSING': 'internal',
  'kernel.CAPABILITY_MISSING': 'internal',
  'kernel.MIGRATION_REQUIRED': 'internal',
  NOT_FOUND: 'not_found',
  'kernel.NOT_FOUND': 'not_found',
  CONFLICT: 'conflict',
  'kernel.CONFLICT': 'conflict',
  'kernel.VERSION_CONFLICT': 'conflict',
  'kernel.MODULE_ALREADY_ENABLED': 'conflict',
  'auth.EMAIL_TAKEN': 'conflict',
  'setup.REQUIRED': 'conflict',
  UNAUTHORIZED: 'unauthenticated',
  'auth.UNAUTHENTICATED': 'unauthenticated',
  'auth.INVALID_CREDENTIALS': 'unauthenticated',
  'auth.INVALID_REFRESH': 'unauthenticated',
  'auth.REFRESH_EXPIRED': 'unauthenticated',
  'auth.REFRESH_REPLAY': 'unauthenticated',
  'setup.TOKEN_REQUIRED': 'unauthenticated',
  FORBIDDEN: 'forbidden',
  'auth.FORBIDDEN': 'forbidden',
  'auth.REGISTRATION_CLOSED': 'forbidden',
  'auth.SELF_DEMOTION': 'forbidden',
  'setup.SECRET_STORE_OFF': 'internal',
  'setup.DRAFT_TOO_LARGE': 'validation',
  'setup.INVALID_SECRET_NAME': 'validation',
  'setup.CATALOG_UNAVAILABLE': 'dependency_unavailable',
  'setup.PULL_FAILED': 'dependency_unavailable',
  'setup.RUNTIME_UNREACHABLE': 'dependency_unavailable',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  TIMEOUT: 'timeout',
  RATE_LIMITED: 'rate_limited',
  BUDGET_EXCEEDED: 'budget_exceeded',
  POLICY_BLOCKED: 'policy_blocked',
  INTERNAL_ERROR: 'internal',
  NOT_IMPLEMENTED: 'internal',
};

const RETRYABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'rate_limited',
  'dependency_unavailable',
  'timeout',
]);

export function categoryFor(code: string, status: number): ErrorCategory {
  const direct = CATEGORY_BY_CODE[code];
  if (direct) return direct;
  const reason = code.includes('.') ? code.slice(code.lastIndexOf('.') + 1) : code;
  const byReason = CATEGORY_BY_CODE[reason];
  if (byReason) return byReason;
  if (status === 400 || status === 422) return 'validation';
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 529) return 'dependency_unavailable';
  return 'internal';
}

export function retryableFor(category: ErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

export interface AppErrorOptions {
  category?: ErrorCategory;
  retryable?: boolean;
  retryAfterMs?: number;
  /** Safe to show anyone; defaults to the message for 4xx and a generic line for 5xx. */
  userMessage?: string;
  cause?: unknown;
}

const GENERIC_USER_MESSAGE = 'Something went wrong. Try again or check the server logs.';

function userMessageFor(status: number, message: string, override?: string): string {
  if (override) return override;
  return status >= 500 ? GENERIC_USER_MESSAGE : message;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly userMessage: string;

  constructor(
    code: string,
    message: string,
    details?: unknown,
    status?: number,
    options: AppErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = status ?? DEFAULT_STATUS[code] ?? 500;
    this.details = details;
    this.category = options.category ?? categoryFor(code, this.statusCode);
    this.retryable = options.retryable ?? retryableFor(this.category);
    this.retryAfterMs = options.retryAfterMs;
    this.userMessage = userMessageFor(this.statusCode, message, options.userMessage);
  }

  /** Canonical envelope for an HTTP/queue boundary. `detail` is operator-only. */
  toEnvelope(correlationId: string): ErrorEnvelope {
    return {
      type: `https://triageai.dev/errors/${this.code}`,
      title: this.code,
      status: this.statusCode,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      ...(this.retryAfterMs === undefined ? {} : { retryAfterMs: this.retryAfterMs }),
      userMessage: this.userMessage,
      detail: this.message,
      correlationId,
    };
  }
}

export interface StructuredError {
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  message: string;
  attempt: number;
  causeCode?: string;
}

function causeCodeOf(cause: unknown): string | undefined {
  if (
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof (cause as { code?: unknown }).code === 'string'
  ) {
    return (cause as { code: string }).code;
  }
  return undefined;
}

/** Serialize any thrown value for a decision record or dead-letter row. */
export function toStructuredError(error: unknown, attempt: number): StructuredError {
  if (error instanceof AppError) {
    const causeCode = causeCodeOf(error.cause);
    return {
      code: error.code,
      category: error.category,
      retryable: error.retryable,
      message: error.message,
      attempt,
      ...(causeCode ? { causeCode } : {}),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    category: 'internal',
    retryable: false,
    message: error instanceof Error ? error.message : String(error),
    attempt,
  };
}

export function bootValidationError(header: string, problems: string[]): AppError {
  return new AppError(
    'kernel.BOOT_VALIDATION_FAILED',
    `${header}\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    problems,
    undefined,
    {
      category: 'internal',
      retryable: false,
      userMessage: 'The server configuration is invalid; check the boot logs.',
    },
  );
}

export function configInvalid(message: string, details?: unknown): AppError {
  return new AppError('kernel.CONFIG_INVALID', message, details, undefined, {
    category: 'validation',
    retryable: false,
    userMessage: message,
  });
}

/** Generic factories (10C). Prefer an owner-qualified code when one exists. */
export function notFound(message = 'Not found', details?: unknown): AppError {
  return new AppError('NOT_FOUND', message, details, 404, {
    category: 'not_found',
    retryable: false,
    userMessage: message,
  });
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError('CONFLICT', message, details, 409, {
    category: 'conflict',
    retryable: false,
    userMessage: message,
  });
}

export function invalid(message: string, details?: unknown): AppError {
  return new AppError('VALIDATION_ERROR', message, details, 400, {
    category: 'validation',
    retryable: false,
    userMessage: message,
  });
}

export function dependencyUnavailable(cause?: unknown, details?: unknown): AppError {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string' && cause.length > 0
        ? cause
        : 'A required dependency is unavailable';
  return new AppError('DEPENDENCY_UNAVAILABLE', message, details, 503, {
    category: 'dependency_unavailable',
    retryable: true,
    userMessage: 'A required service is temporarily unavailable. Try again shortly.',
    cause,
  });
}

export function timeout(message = 'The dependency timed out', details?: unknown): AppError {
  return new AppError('TIMEOUT', message, details, 504, {
    category: 'timeout',
    retryable: true,
    userMessage: 'The request timed out. Try again.',
  });
}

export function rateLimited(retryAfterMs?: number, message = 'Too many requests'): AppError {
  return new AppError('RATE_LIMITED', message, undefined, 429, {
    category: 'rate_limited',
    retryable: true,
    retryAfterMs,
    userMessage: 'Too many requests. Wait a moment and try again.',
  });
}

export function policyBlocked(message: string, details?: unknown): AppError {
  return new AppError('POLICY_BLOCKED', message, details, 403, {
    category: 'policy_blocked',
    retryable: false,
    userMessage: message,
  });
}

/** A genuine server invariant/misconfiguration (missing adapter, impossible state). */
export function internal(message = 'Internal error', details?: unknown): AppError {
  return new AppError('INTERNAL_ERROR', message, details, 500, {
    category: 'internal',
    retryable: false,
  });
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

export interface HttpFailureArgs {
  /** Code prefix, e.g. `ai`, `ollama`, `integration`. */
  codePrefix: string;
  /** Human label for messages, e.g. `ai-service`. */
  label: string;
  status: number;
  retryAfter?: string | null;
  body?: string;
  cause?: unknown;
}

/**
 * Classify an HTTP dependency failure (10C.T4). 408/429/5xx are retryable;
 * 4xx are permanent; `Retry-After` is preserved on the error.
 */
export function httpFailure(args: HttpFailureArgs): AppError {
  const message = `${args.label} request failed (${args.status})`;
  const details = {
    status: args.status,
    ...(args.body ? { body: args.body.slice(0, 500) } : {}),
  };
  const retryAfterMs = parseRetryAfterMs(args.retryAfter);
  const options = (code: string, status: number, category: ErrorCategory, retryable: boolean) =>
    new AppError(code, message, details, status, {
      category,
      retryable,
      retryAfterMs,
      cause: args.cause,
    });

  if (args.status === 408) return options(`${args.codePrefix}.TIMEOUT`, 504, 'timeout', true);
  if (args.status === 429)
    return options(`${args.codePrefix}.RATE_LIMITED`, 429, 'rate_limited', true);
  if (args.status >= 500)
    return options(`${args.codePrefix}.UNAVAILABLE`, 502, 'dependency_unavailable', true);
  if (args.status === 401)
    return options(`${args.codePrefix}.UNAUTHORIZED`, 502, 'unauthenticated', false);
  if (args.status === 403) return options(`${args.codePrefix}.FORBIDDEN`, 502, 'forbidden', false);
  if (args.status === 404) return options(`${args.codePrefix}.NOT_FOUND`, 502, 'not_found', false);
  if (args.status === 409) return options(`${args.codePrefix}.CONFLICT`, 502, 'conflict', false);
  if (args.status >= 400 && args.status < 500)
    return options(`${args.codePrefix}.INVALID`, 502, 'validation', false);
  return options(`${args.codePrefix}.ERROR`, 502, 'internal', false);
}

/** Classify a network/timeout failure from `fetch` (10C.T4). Both retryable. */
export function fetchFailure(args: {
  codePrefix: string;
  label: string;
  cause: unknown;
}): AppError {
  const cause = args.cause;
  const name = cause instanceof Error ? cause.name : '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const timedOut = name === 'TimeoutError' || name === 'AbortError' || /timed out/i.test(message);
  return new AppError(
    `${args.codePrefix}.${timedOut ? 'TIMEOUT' : 'UNAVAILABLE'}`,
    `${args.label} request failed: ${message}`,
    undefined,
    timedOut ? 504 : 503,
    {
      category: timedOut ? 'timeout' : 'dependency_unavailable',
      retryable: true,
      cause,
      userMessage: timedOut
        ? 'The request timed out. Try again.'
        : 'A required service is temporarily unavailable. Try again shortly.',
    },
  );
}
