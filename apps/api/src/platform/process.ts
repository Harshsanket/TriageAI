/**
 * Process-level fault handling (10C.T6). A fatal fault must leave the
 * container in a state Docker can restart, instead of running broken: log it
 * once with a correlation id, then exit non-zero.
 */
import type { KernelLogger } from '@triageai/kernel';

export interface ProcessGuardOptions {
  logger: KernelLogger;
  /** Test seam; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Install `unhandledRejection` / `uncaughtException` handlers. Returns a
 * disposer used by tests. The first fault wins: a second fault while the
 * process is already shutting down is ignored, so the log stays one line.
 */
export function installProcessGuards(options: ProcessGuardOptions): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let handling = false;

  const crash = (kind: 'unhandledRejection' | 'uncaughtException', fault: unknown): void => {
    if (handling) return;
    handling = true;
    const correlationId = `process-${process.pid}-${Date.now()}`;
    const err = fault instanceof Error ? fault : undefined;
    const payload = { err, correlationId, kind, fault: err ? undefined : String(fault) };
    const message = 'fatal process fault; exiting so the supervisor restarts cleanly';
    if (options.logger.fatal) options.logger.fatal(payload, message);
    else options.logger.error(payload, message);
    // Give pino a turn to flush before the process disappears.
    setTimeout(() => exit(1), 50);
  };

  const onRejection = (reason: unknown): void => crash('unhandledRejection', reason);
  const onException = (error: unknown): void => crash('uncaughtException', error);

  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);

  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}
