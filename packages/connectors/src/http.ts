/** Injected-fetch wrapper: timeout, external abort and typed transport errors. */
import { ConnectorError } from './types.js';
import type { ConnectorFetch } from './types.js';

export interface TimeoutFetchOptions {
  request: ConnectorFetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Error-code prefix, e.g. `connector.GRAPHQL`. */
  codePrefix: string;
  label: string;
}

export async function fetchWithTimeout(options: TimeoutFetchOptions): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  timer.unref?.();
  const forwardAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    return await options.request(options.url, { ...options.init, signal: controller.signal });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ConnectorError(`${options.codePrefix}_ABORTED`, `${options.label} was aborted`, {
        cause: error,
      });
    }
    if (timedOut) {
      throw new ConnectorError(
        `${options.codePrefix}_TIMEOUT`,
        `${options.label} timed out after ${options.timeoutMs}ms`,
        { retryable: true, cause: error },
      );
    }
    throw new ConnectorError(
      `${options.codePrefix}_TRANSPORT_ERROR`,
      `${options.label} request failed`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
