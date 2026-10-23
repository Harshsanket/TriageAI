/**
 * Typed application errors, shared contract with the kernel
 * (packages/kernel/src/errors.ts). Handlers convert these to RFC 7807-style
 * problem responses so the API never leaks stack traces or raw driver errors.
 */
import { AppError } from '@triageai/kernel';

export { AppError };

export function notImplemented(feature: string): AppError {
  return new AppError('NOT_IMPLEMENTED', `${feature} is not implemented yet`);
}
