/**
 * OAuth 2.0 authorization-code + PKCE helpers (Phase 15.T7).
 *
 * The host owns the browser redirect, the encrypted `TokenStore`, connection
 * records and refresh scheduling. This module only builds/validates the
 * protocol messages and never logs codes, tokens or client secrets.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { checkedTimeout, normalizeHeaders, parseHttpUrl } from './helpers.js';
import { fetchWithTimeout } from './http.js';
import { ConnectorError } from './types.js';
import type { ConnectorFetch } from './types.js';

export interface PkceChallenge {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** Create an RFC 7636 verifier and its S256 challenge. Default length: 64. */
export function createPkce(length = 64): PkceChallenge {
  if (!Number.isInteger(length) || length < 43 || length > 128) {
    throw new ConnectorError(
      'connector.OAUTH_PKCE_INVALID',
      'PKCE verifier length must be an integer between 43 and 128 characters',
    );
  }
  const size = length;
  let verifier = '';
  while (verifier.length < size) {
    verifier += randomBytes(48).toString('base64url');
  }
  verifier = verifier.slice(0, size);
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    method: 'S256',
  };
}

export interface AuthorizeUrlOptions {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  /** Host-generated, stored with the pending authorization request. */
  state: string;
  /** `createPkce().challenge`; only S256 is accepted. */
  codeChallenge: string;
  /** Optional OIDC nonce, validated against the ID token by the host. */
  nonce?: string;
  extraParams?: Record<string, string>;
}

const AUTHORIZE_RESERVED = new Set([
  'response_type',
  'client_id',
  'redirect_uri',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
  'nonce',
]);

const TOKEN_RESERVED = new Set([
  'grant_type',
  'code',
  'redirect_uri',
  'code_verifier',
  'refresh_token',
  'client_id',
  'client_secret',
  'scope',
]);

function assertBindingValue(value: string, label: string, code: string): void {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 512 ||
    !/^[A-Za-z0-9._~-]+$/.test(value)
  ) {
    throw new ConnectorError(code, `${label} must be 16–512 URL-safe characters`);
  }
}

function assertClientId(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\r\n]/.test(value)) {
    throw new ConnectorError('connector.OAUTH_INVALID_CLIENT', 'OAuth clientId is required');
  }
  return value;
}

function normalizeScopeList(scopes: string[] | undefined): string[] {
  if (scopes === undefined) return [];
  if (!Array.isArray(scopes)) {
    throw new ConnectorError('connector.OAUTH_INVALID_SCOPE', 'OAuth scopes must be an array');
  }
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !scope.trim() || /\s/.test(scope)) {
      throw new ConnectorError(
        'connector.OAUTH_INVALID_SCOPE',
        `OAuth scope "${scope}" must be a non-empty token without whitespace`,
      );
    }
    seen.add(scope.trim());
  }
  return [...seen];
}

function addExtraParams(
  target: URL | URLSearchParams,
  extraParams: Record<string, string> | undefined,
  reserved: Set<string>,
  label: string,
): void {
  if (extraParams === undefined) return;
  for (const [key, value] of Object.entries(extraParams)) {
    if (reserved.has(key.toLowerCase())) {
      throw new ConnectorError(
        'connector.OAUTH_INVALID_PARAMS',
        `${label} extraParams may not override "${key}"`,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new ConnectorError(
        'connector.OAUTH_INVALID_PARAMS',
        `${label} extraParams key "${key}" is invalid`,
      );
    }
    if (typeof value !== 'string' || /[\r\n]/.test(value)) {
      throw new ConnectorError(
        'connector.OAUTH_INVALID_PARAMS',
        `${label} extraParams value for "${key}" must be a single-line string`,
      );
    }
    if (target instanceof URL) target.searchParams.set(key, value);
    else target.set(key, value);
  }
}

export function authorizeUrl(options: AuthorizeUrlOptions): string {
  const endpoint = parseHttpUrl(options.authorizationEndpoint, 'OAuth authorization endpoint', {
    secure: true,
    code: 'connector.OAUTH_INVALID_ENDPOINT',
  });
  const redirectUri = parseHttpUrl(options.redirectUri, 'OAuth redirect URI', {
    secure: true,
    code: 'connector.OAUTH_INVALID_REDIRECT',
  });
  const clientId = assertClientId(options.clientId);
  assertBindingValue(options.state, 'OAuth state', 'connector.OAUTH_STATE_INVALID');
  if (options.nonce !== undefined) {
    assertBindingValue(options.nonce, 'OAuth nonce', 'connector.OAUTH_NONCE_INVALID');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.codeChallenge)) {
    throw new ConnectorError(
      'connector.OAUTH_PKCE_INVALID',
      'codeChallenge must be a 43-character S256 challenge',
    );
  }

  endpoint.searchParams.set('response_type', 'code');
  endpoint.searchParams.set('client_id', clientId);
  endpoint.searchParams.set('redirect_uri', redirectUri.toString());
  const scopes = normalizeScopeList(options.scopes);
  if (scopes.length > 0) endpoint.searchParams.set('scope', scopes.join(' '));
  endpoint.searchParams.set('state', options.state);
  endpoint.searchParams.set('code_challenge', options.codeChallenge);
  endpoint.searchParams.set('code_challenge_method', 'S256');
  if (options.nonce !== undefined) endpoint.searchParams.set('nonce', options.nonce);
  addExtraParams(endpoint, options.extraParams, AUTHORIZE_RESERVED, 'OAuth authorization');
  return endpoint.toString();
}

export const TokenSetSchema = z.object({
  accessToken: z.string().min(1).max(20_000),
  tokenType: z.string().min(1).max(50),
  /** ISO timestamp; `null` means the provider did not send `expires_in`. */
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  refreshToken: z.string().min(1).max(20_000).optional(),
  scope: z.string().max(2_000).optional(),
  idToken: z.string().min(1).max(50_000).optional(),
});

export type TokenSet = z.infer<typeof TokenSetSchema>;

/**
 * The host stores tokens encrypted (Phase 11 secret store) under a stable
 * connection id. `get` returns `null` for a missing connection.
 */
export interface TokenStore {
  get(connectionId: string): Promise<TokenSet | null>;
  set(connectionId: string, tokens: TokenSet): Promise<void>;
  delete(connectionId: string): Promise<void>;
}

export interface OAuthTokenRequestOptions {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  fetch?: ConnectorFetch;
  timeoutMs?: number;
  /** Injectable clock for deterministic expiry tests. */
  now?: () => number;
  headers?: Record<string, string>;
  extraParams?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ExchangeCodeOptions extends OAuthTokenRequestOptions {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface RefreshTokenOptions extends OAuthTokenRequestOptions {
  refreshToken: string;
  scopes?: string[];
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1).max(20_000),
  token_type: z.string().min(1).max(50).optional(),
  expires_in: z.union([z.number(), z.string()]).optional(),
  refresh_token: z.string().min(1).max(20_000).optional(),
  scope: z.string().max(2_000).optional(),
  id_token: z.string().min(1).max(50_000).optional(),
});

const OAuthErrorSchema = z.object({
  error: z.string().min(1).max(200),
  error_description: z.string().max(500).optional(),
});

const MAX_EXPIRES_IN = 315_360_000;

function normalizeExpiresIn(value: number | string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const seconds = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_EXPIRES_IN) {
    throw new ConnectorError(
      'connector.OAUTH_RESPONSE_INVALID',
      `${label} returned an invalid expires_in`,
    );
  }
  return seconds;
}

function providerError(payload: unknown, status: number): ConnectorError {
  const provider = OAuthErrorSchema.safeParse(payload);
  const retryable = status === 429 || status >= 500;
  if (provider.success) {
    const description = provider.data.error_description?.slice(0, 300);
    return new ConnectorError(
      'connector.OAUTH_TOKEN_ERROR',
      `OAuth provider returned ${provider.data.error}${description ? `: ${description}` : ''}`,
      { retryable, details: { status, error: provider.data.error } },
    );
  }
  return new ConnectorError(
    'connector.OAUTH_HTTP_ERROR',
    `OAuth token endpoint returned HTTP ${status}`,
    { retryable, details: { status } },
  );
}

async function requestToken(
  options: OAuthTokenRequestOptions,
  form: URLSearchParams,
  label: string,
  carryRefreshToken?: string,
): Promise<TokenSet> {
  const endpoint = parseHttpUrl(options.tokenEndpoint, 'OAuth token endpoint', {
    secure: true,
    code: 'connector.OAUTH_INVALID_ENDPOINT',
  });
  const clientId = assertClientId(options.clientId);
  const clientSecret = options.clientSecret;
  if (
    clientSecret !== undefined &&
    (typeof clientSecret !== 'string' || !clientSecret || /[\r\n]/.test(clientSecret))
  ) {
    throw new ConnectorError(
      'connector.OAUTH_INVALID_CLIENT',
      'OAuth clientSecret must be a single-line string',
    );
  }
  const timeoutMs = checkedTimeout(options.timeoutMs, 10_000, 'OAuth token request');
  const headers = normalizeHeaders(options.headers, 'OAuth token request');
  const body = new URLSearchParams(form);
  addExtraParams(body, options.extraParams, TOKEN_RESERVED, 'OAuth token request');
  headers['content-type'] = 'application/x-www-form-urlencoded';
  headers.accept = 'application/json';
  if (clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
  }

  const response = await fetchWithTimeout({
    request: options.fetch ?? globalThis.fetch,
    url: endpoint.toString(),
    init: { method: 'POST', headers, body: body.toString() },
    timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    codePrefix: 'connector.OAUTH',
    label,
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    throw providerError(payload, response.status);
  }
  if (payload === undefined) {
    throw new ConnectorError(
      'connector.OAUTH_RESPONSE_INVALID',
      `${label} returned a non-JSON response`,
    );
  }
  const parsed = TokenResponseSchema.safeParse(payload);
  if (!parsed.success) {
    const error = OAuthErrorSchema.safeParse(payload);
    if (error.success) throw providerError(payload, response.status);
    throw new ConnectorError(
      'connector.OAUTH_RESPONSE_INVALID',
      `${label} returned an invalid token response`,
    );
  }
  const expiresIn = normalizeExpiresIn(parsed.data.expires_in, label);
  const expiresAt =
    expiresIn === undefined
      ? null
      : new Date((options.now ?? Date.now)() + expiresIn * 1000).toISOString();
  const refreshToken = parsed.data.refresh_token ?? carryRefreshToken;
  return {
    accessToken: parsed.data.access_token,
    tokenType: parsed.data.token_type?.trim() || 'Bearer',
    expiresAt,
    ...(refreshToken ? { refreshToken } : {}),
    ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
    ...(parsed.data.id_token ? { idToken: parsed.data.id_token } : {}),
  };
}

export async function exchangeCode(options: ExchangeCodeOptions): Promise<TokenSet> {
  if (typeof options.code !== 'string' || !options.code || /[\r\n]/.test(options.code)) {
    throw new ConnectorError('connector.OAUTH_INVALID_CODE', 'authorization code is required');
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(options.codeVerifier)) {
    throw new ConnectorError(
      'connector.OAUTH_PKCE_INVALID',
      'codeVerifier must be 43–128 characters from the PKCE unreserved set',
    );
  }
  const redirectUri = parseHttpUrl(options.redirectUri, 'OAuth redirect URI', {
    secure: true,
    code: 'connector.OAUTH_INVALID_REDIRECT',
  });
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: redirectUri.toString(),
    code_verifier: options.codeVerifier,
  });
  return requestToken(options, form, 'OAuth code exchange');
}

export async function refreshToken(options: RefreshTokenOptions): Promise<TokenSet> {
  if (
    typeof options.refreshToken !== 'string' ||
    !options.refreshToken ||
    /[\r\n]/.test(options.refreshToken)
  ) {
    throw new ConnectorError('connector.OAUTH_INVALID_REFRESH', 'refresh token is required');
  }
  const scopes = normalizeScopeList(options.scopes);
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
  });
  if (scopes.length > 0) form.set('scope', scopes.join(' '));
  return requestToken(options, form, 'OAuth token refresh', options.refreshToken);
}

export function validateState(expected: string, received: string | null | undefined): void {
  validateBinding('state', expected, received);
}

export function validateNonce(expected: string, received: string | null | undefined): void {
  validateBinding('nonce', expected, received);
}

function validateBinding(
  kind: 'state' | 'nonce',
  expected: string,
  received: string | null | undefined,
): void {
  assertBindingValue(
    expected,
    `OAuth ${kind}`,
    kind === 'state' ? 'connector.OAUTH_STATE_INVALID' : 'connector.OAUTH_NONCE_INVALID',
  );
  if (typeof received !== 'string' || received.length === 0) {
    throw new ConnectorError(
      kind === 'state' ? 'connector.OAUTH_STATE_MISMATCH' : 'connector.OAUTH_NONCE_MISMATCH',
      `OAuth ${kind} is missing from the callback`,
    );
  }
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(received).digest();
  if (!timingSafeEqual(left, right)) {
    throw new ConnectorError(
      kind === 'state' ? 'connector.OAUTH_STATE_MISMATCH' : 'connector.OAUTH_NONCE_MISMATCH',
      `OAuth ${kind} did not match the pending authorization request`,
    );
  }
}

export interface TokenExpiryOptions {
  now?: () => number;
  /** Refresh this long before the recorded expiry (default 60 s). */
  skewMs?: number;
}

export function isTokenExpired(
  tokens: Pick<TokenSet, 'expiresAt'>,
  options: TokenExpiryOptions = {},
): boolean {
  if (tokens.expiresAt === null) return false;
  const expires = Date.parse(tokens.expiresAt);
  if (Number.isNaN(expires)) return true;
  return expires <= (options.now ?? Date.now)() + (options.skewMs ?? 60_000);
}
