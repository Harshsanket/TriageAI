import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  isTokenExpired,
  refreshToken,
  TokenSetSchema,
  validateNonce,
  validateState,
} from '../src/index.js';
import type { ConnectorFetch } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: ConnectorFetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(body, status);
  };
  return { calls, fetch };
}

const NOW = 1_700_000_000_000;
const REDIRECT = 'https://app.example/oauth/callback';
const TOKEN_ENDPOINT = 'https://idp.example/oauth/token';

describe('OAuth connector helpers (15.T7)', () => {
  it('creates an RFC 7636 verifier and S256 challenge', () => {
    const pkce = createPkce();

    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.method).toBe('S256');
    expect(() => createPkce(42)).toThrow(/between 43 and 128/);
  });

  it('builds an authorization URL with PKCE and state', () => {
    const pkce = createPkce();
    const url = new URL(
      authorizeUrl({
        authorizationEndpoint: 'https://idp.example/oauth/authorize',
        clientId: 'triageai',
        redirectUri: REDIRECT,
        scopes: ['openid', 'calendar.read', 'calendar.read'],
        state: 'state-0123456789abcdef',
        codeChallenge: pkce.challenge,
        nonce: 'nonce-0123456789abcdef',
        extraParams: { prompt: 'consent' },
      }),
    );

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('triageai');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('openid calendar.read');
    expect(url.searchParams.get('state')).toBe('state-0123456789abcdef');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('nonce-0123456789abcdef');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('rejects reserved extra params, insecure endpoints and non-S256 challenges', () => {
    const pkce = createPkce();
    const base = {
      authorizationEndpoint: 'https://idp.example/oauth/authorize',
      clientId: 'triageai',
      redirectUri: REDIRECT,
      state: 'state-0123456789abcdef',
      codeChallenge: pkce.challenge,
    };

    expect(() => authorizeUrl({ ...base, extraParams: { state: 'override' } })).toThrow(
      /may not override "state"/,
    );
    expect(() =>
      authorizeUrl({ ...base, authorizationEndpoint: 'http://idp.example/oauth/authorize' }),
    ).toThrow(/must use https/);
    expect(() => authorizeUrl({ ...base, codeChallenge: pkce.verifier })).toThrow(
      /43-character S256 challenge/,
    );
  });

  it('validates state and nonce in constant time', () => {
    const value = 'state-0123456789abcdef';
    expect(() => validateState(value, value)).not.toThrow();
    expect(() => validateState(value, 'state-fedcba9876543210')).toThrow(/did not match/);
    expect(() => validateState(value, null)).toThrow(/missing/);
    expect(() => validateNonce('nonce-0123456789abcdef', 'nonce-0123456789abcdef')).not.toThrow();
    expect(() => validateNonce('nonce-0123456789abcdef', 'nonce-fedcba9876543210')).toThrow(
      /did not match/,
    );
  });

  it('exchanges a code using PKCE and HTTP Basic client auth', async () => {
    const pkce = createPkce();
    const { calls, fetch } = tokenFetch({
      access_token: 'access-1',
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'refresh-1',
      scope: 'calendar.read',
    });

    const tokens = await exchangeCode({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'triageai',
      clientSecret: 'secret',
      code: 'auth-code',
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
      fetch,
      now: () => NOW,
    });

    expect(tokens).toEqual({
      accessToken: 'access-1',
      tokenType: 'Bearer',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
      refreshToken: 'refresh-1',
      scope: 'calendar.read',
    });
    expect(TokenSetSchema.parse(tokens)).toEqual(tokens);

    const init = calls[0]?.init;
    expect(calls[0]?.url).toBe(TOKEN_ENDPOINT);
    expect(init?.headers).toMatchObject({
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from('triageai:secret').toString('base64')}`,
    });
    const form = new URLSearchParams(String(init?.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('auth-code');
    expect(form.get('code_verifier')).toBe(pkce.verifier);
    expect(form.get('redirect_uri')).toBe(REDIRECT);
    expect(form.get('client_id')).toBeNull();
  });

  it('uses form client_id when no client secret is configured', async () => {
    const pkce = createPkce();
    const { calls, fetch } = tokenFetch({ access_token: 'access-1' });

    await exchangeCode({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'public-client',
      code: 'auth-code',
      codeVerifier: pkce.verifier,
      redirectUri: REDIRECT,
      fetch,
    });

    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(form.get('client_id')).toBe('public-client');
    expect(calls[0]?.init.headers).not.toMatchObject({ authorization: expect.any(String) });
  });

  it('carries the old refresh token forward when the provider does not rotate it', async () => {
    const { fetch } = tokenFetch({ access_token: 'access-2' });
    const tokens = await refreshToken({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'triageai',
      refreshToken: 'refresh-1',
      fetch,
    });

    expect(tokens.accessToken).toBe('access-2');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBeNull();
    expect(tokens.tokenType).toBe('Bearer');
  });

  it('stores a rotated refresh token when one is returned', async () => {
    const { fetch } = tokenFetch({
      access_token: 'access-3',
      refresh_token: 'refresh-2',
      expires_in: '60',
    });
    const tokens = await refreshToken({
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: 'triageai',
      refreshToken: 'refresh-1',
      fetch,
      now: () => NOW,
    });

    expect(tokens.refreshToken).toBe('refresh-2');
    expect(tokens.expiresAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('surfaces provider errors without leaking the authorization code', async () => {
    const { fetch } = tokenFetch(
      { error: 'invalid_grant', error_description: 'authorization code expired' },
      400,
    );
    const pkce = createPkce();

    await expect(
      exchangeCode({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: 'triageai',
        code: 'super-secret-code',
        codeVerifier: pkce.verifier,
        redirectUri: REDIRECT,
        fetch,
      }),
    ).rejects.toMatchObject({
      code: 'connector.OAUTH_TOKEN_ERROR',
      retryable: false,
      details: { status: 400, error: 'invalid_grant' },
    });
  });

  it('rejects malformed token responses and short PKCE verifiers', async () => {
    const { fetch } = tokenFetch({ token_type: 'Bearer' });
    await expect(
      exchangeCode({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: 'triageai',
        code: 'auth-code',
        codeVerifier: 'short',
        redirectUri: REDIRECT,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'connector.OAUTH_PKCE_INVALID' });

    const pkce = createPkce();
    await expect(
      exchangeCode({
        tokenEndpoint: TOKEN_ENDPOINT,
        clientId: 'triageai',
        code: 'auth-code',
        codeVerifier: pkce.verifier,
        redirectUri: REDIRECT,
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'connector.OAUTH_RESPONSE_INVALID' });
  });

  it('computes expiry with a refresh skew', () => {
    const soon = new Date(NOW + 30_000).toISOString();
    const later = new Date(NOW + 120_000).toISOString();

    expect(isTokenExpired({ expiresAt: soon }, { now: () => NOW })).toBe(true);
    expect(isTokenExpired({ expiresAt: later }, { now: () => NOW })).toBe(false);
    expect(isTokenExpired({ expiresAt: later }, { now: () => NOW, skewMs: 0 })).toBe(false);
    expect(isTokenExpired({ expiresAt: null }, { now: () => NOW })).toBe(false);
    expect(isTokenExpired({ expiresAt: 'not-a-date' }, { now: () => NOW })).toBe(true);
  });
});
