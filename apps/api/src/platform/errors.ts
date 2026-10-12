/**
 * Typed application errors. Handlers convert these to RFC 7807-style
 * problem responses so the API never leaks stack traces or raw driver errors.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  NOT_IMPLEMENTED: 501,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = DEFAULT_STATUS[code];
    this.details = details;
  }
}

export function notImplemented(feature: string): AppError {
  return new AppError('NOT_IMPLEMENTED', `${feature} is not implemented yet`);
}
