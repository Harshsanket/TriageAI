/**
 * Generic HTTP delivery plumbing shared by integration adapters (Phase 8).
 * Provider-specific payload/ref shapes stay in the modules; retries, rate
 * limits, credential rotation and delivery idempotency live here so every
 * adapter gets the same behaviour and the contract suite can pin it.
 */
import { AppError, fetchFailure, httpFailure, parseRetryAfterMs } from '../errors.js';
import type {
  DeliveryContext,
  DeliveryResult,
  OutboundIntent,
  OutboundMatch,
  OutboundQuery,
  OutputChannel,
} from '../types.js';

export interface TokenRotatorOptions {
  tokens: string[];
  header?: string;
  prefix?: string;
}

export class TokenRotator {
  private index = 0;

  constructor(private readonly options: TokenRotatorOptions) {}

  get enabled(): boolean {
    return this.options.tokens.length > 0;
  }

  headers(): Record<string, string> {
    const token = this.options.tokens[this.index];
    if (!token) return {};
    return {
      [this.options.header ?? 'authorization']: `${this.options.prefix ?? 'Bearer '}${token}`,
    };
  }

  rotate(): boolean {
    if (this.index + 1 >= this.options.tokens.length) return false;
    this.index += 1;
    return true;
  }
}

export interface RequestWithRetryOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  auth?: TokenRotator;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Disable automatic 5xx retries for non-idempotent creates. */
  retryServerErrors?: boolean;
  /** Code prefix for classified failures (default `integration`). */
  codePrefix?: string;
  /** Human label for classified failures (default `outbound request`). */
  label?: string;
}

export interface RetriedResponse {
  status: number;
  bodyText: string;
  body: unknown;
  headers: Headers;
}

const sleepDefault = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

function retryDelayMs(response: Response, attempt: number): number {
  return (
    parseRetryAfterMs(response.headers.get('retry-after')) ?? Math.min(5_000, 100 * 2 ** attempt)
  );
}

/**
 * Sends one logical request, retrying 429/5xx and rotating credentials on
 * 401/403. Exhausted retries throw a classified AppError (timeout,
 * rate_limited or dependency_unavailable; 4xx stays permanent), so the caller
 * can retry only what can succeed — outages never mutate domain state.
 */
export async function requestWithRetry(options: RequestWithRetryOptions): Promise<RetriedResponse> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAttempts = options.maxAttempts ?? 4;
  const sleep = options.sleep ?? sleepDefault;
  const codePrefix = options.codePrefix ?? 'integration';
  const label = options.label ?? 'outbound request';
  let lastStatus = 0;
  let lastBody = '';
  let lastRetryAfter: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
      ...(options.auth?.headers() ?? {}),
    };
    if (options.body !== undefined) headers['content-type'] ??= 'application/json';
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: options.method ?? 'POST',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options.signal,
      });
    } catch (error) {
      if (attempt + 1 < maxAttempts) {
        await sleep(Math.min(5_000, 100 * 2 ** attempt));
        continue;
      }
      throw fetchFailure({ codePrefix, label, cause: error });
    }
    lastStatus = response.status;
    lastRetryAfter = response.headers.get('retry-after');
    lastBody = await response.text();

    if ((response.status === 401 || response.status === 403) && options.auth?.rotate()) {
      continue;
    }
    if (
      response.status === 408 ||
      response.status === 429 ||
      (response.status >= 500 && options.retryServerErrors !== false)
    ) {
      if (attempt + 1 < maxAttempts) {
        await sleep(retryDelayMs(response, attempt));
        continue;
      }
    }
    if (!response.ok) {
      throw httpFailure({
        codePrefix,
        label,
        status: response.status,
        retryAfter: lastRetryAfter,
        body: lastBody,
      });
    }
    let body: unknown = lastBody;
    try {
      body = lastBody ? (JSON.parse(lastBody) as unknown) : null;
    } catch {
      body = lastBody;
    }
    return { status: response.status, body, bodyText: lastBody, headers: response.headers };
  }

  throw httpFailure({
    codePrefix,
    label,
    status: lastStatus,
    retryAfter: lastRetryAfter,
    body: lastBody,
  });
}

export interface HttpOutputChannelOptions {
  channel: string;
  enabled: () => boolean;
  request: (
    ctx: DeliveryContext,
    intent: OutboundIntent,
  ) => {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    retryServerErrors?: boolean;
  };
  parse: (
    response: RetriedResponse,
    ctx: DeliveryContext,
    intent: OutboundIntent,
  ) => { ref: string; detail?: Record<string, unknown> };
  search?: (
    ctx: DeliveryContext,
    query: OutboundQuery,
    request: typeof requestWithRetry,
  ) => Promise<OutboundMatch[]>;
  auth?: TokenRotator;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Shared adapter shell: disabled check + retries + idempotent delivery cache. */
export class HttpOutputChannel implements OutputChannel {
  private readonly delivered = new Map<string, DeliveryResult>();

  constructor(private readonly options: HttpOutputChannelOptions) {}

  async deliver(ctx: DeliveryContext, intent: OutboundIntent): Promise<DeliveryResult> {
    if (!this.options.enabled()) {
      throw new AppError(
        'INTEGRATION_DISABLED',
        `output channel "${this.options.channel}" is not configured`,
        undefined,
        503,
        { category: 'internal', retryable: false, userMessage: 'This integration is not enabled.' },
      );
    }
    const key = intent.idempotencyKey ?? ctx.idempotencyKey;
    if (key) {
      const cached = this.delivered.get(key);
      if (cached) return { ...cached, deduped: true };
    }
    const request = this.options.request(ctx, intent);
    const response = await requestWithRetry({
      ...request,
      retryServerErrors: request.retryServerErrors,
      auth: this.options.auth,
      fetchImpl: this.options.fetchImpl,
      maxAttempts: this.options.maxAttempts,
      sleep: this.options.sleep,
      codePrefix: 'integration',
      label: this.options.channel,
    });
    const parsed = this.options.parse(response, ctx, intent);
    const result: DeliveryResult = {
      ref: parsed.ref,
      channel: this.options.channel,
      ...(parsed.detail ? { detail: parsed.detail } : {}),
    };
    if (key) this.delivered.set(key, result);
    return result;
  }

  async search(ctx: DeliveryContext, query: OutboundQuery): Promise<OutboundMatch[]> {
    if (!this.options.search) return [];
    if (!this.options.enabled()) {
      throw new AppError(
        'INTEGRATION_DISABLED',
        `output channel "${this.options.channel}" is not configured`,
        undefined,
        503,
        { category: 'internal', retryable: false, userMessage: 'This integration is not enabled.' },
      );
    }
    return this.options.search(ctx, query, requestWithRetry);
  }
}
