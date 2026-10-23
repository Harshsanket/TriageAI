/**
 * Kernel error contract. All errors are typed { code, httpStatus, details } —
 * see docs/contracts/module-contract.md §3 (host maps to RFC-7807 responses).
 */

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
};

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = status ?? DEFAULT_STATUS[code] ?? 500;
    this.details = details;
  }
}

export function bootValidationError(header: string, problems: string[]): AppError {
  return new AppError(
    'kernel.BOOT_VALIDATION_FAILED',
    `${header}\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    problems,
  );
}

export function configInvalid(message: string, details?: unknown): AppError {
  return new AppError('kernel.CONFIG_INVALID', message, details);
}
