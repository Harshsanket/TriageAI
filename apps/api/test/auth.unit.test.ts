import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/platform/auth/password.js';
import { isAllowed, ruleFor } from '../src/platform/auth/rbac.js';
import { signAccessToken, verifyAccessToken } from '../src/platform/auth/tokens.js';
import { redactValue } from '../src/platform/redact.js';

const SECRET = 'unit-test-secret-at-least-32-characters';

describe('password hashing', () => {
  it('hashes with argon2id and verifies only the right password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('uses a fresh salt per hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same-password'),
      hashPassword('same-password'),
    ]);
    expect(a).not.toBe(b);
  });
});

describe('access tokens', () => {
  it('round-trips signed claims', async () => {
    const token = await signAccessToken(
      { sub: 'u1', email: 'agent@example.dev', role: 'agent', sid: 's1' },
      { secret: SECRET, ttlSeconds: 60 },
    );
    await expect(verifyAccessToken(token, { secret: SECRET })).resolves.toEqual({
      sub: 'u1',
      email: 'agent@example.dev',
      role: 'agent',
      sid: 's1',
    });
  });

  it('rejects a tampered signature and a wrong secret', async () => {
    const token = await signAccessToken(
      { sub: 'u1', email: 'a@example.dev', role: 'admin', sid: 's1' },
      { secret: SECRET, ttlSeconds: 60 },
    );
    await expect(
      verifyAccessToken(`${token.slice(0, -2)}xx`, { secret: SECRET }),
    ).rejects.toMatchObject({ code: 'auth.UNAUTHENTICATED' });
    await expect(
      verifyAccessToken(token, { secret: 'another-secret-at-least-32-characters-long' }),
    ).rejects.toMatchObject({ code: 'auth.UNAUTHENTICATED' });
  });
});

describe('RBAC matrix', () => {
  it('keeps operational endpoints public', () => {
    expect(isAllowed('customer', 'GET', '/healthz')).toBe(true);
    expect(isAllowed('customer', 'GET', '/readyz')).toBe(true);
    expect(isAllowed('customer', 'GET', '/metrics')).toBe(true);
    expect(isAllowed('customer', 'POST', '/api/v1/auth/login')).toBe(true);
    expect(isAllowed('customer', 'POST', '/api/v1/integrations/github/webhook')).toBe(true);
  });

  it('lets customers create tickets but not read the agent queue or admin surface', () => {
    expect(isAllowed('customer', 'POST', '/api/v1/support/tickets')).toBe(true);
    expect(isAllowed('customer', 'GET', '/api/v1/support/tickets/t1')).toBe(true);
    expect(isAllowed('customer', 'GET', '/api/v1/support/queue')).toBe(false);
    expect(isAllowed('customer', 'GET', '/api/v1/system/modules')).toBe(false);
    expect(isAllowed('customer', 'GET', '/api/v1/system/config')).toBe(false);
  });

  it('lets agents operate tickets/runs but not promote models or manage users', () => {
    expect(isAllowed('agent', 'GET', '/api/v1/support/queue')).toBe(true);
    expect(isAllowed('agent', 'POST', '/api/v1/support/tickets/t1/resolve')).toBe(true);
    expect(isAllowed('agent', 'GET', '/api/v1/system/runs')).toBe(true);
    expect(isAllowed('agent', 'PATCH', '/api/v1/system/candidates/c1')).toBe(true);
    expect(isAllowed('agent', 'POST', '/api/v1/models/m1/promote')).toBe(false);
    expect(isAllowed('agent', 'POST', '/api/v1/auth/users')).toBe(false);
    expect(isAllowed('agent', 'PUT', '/api/v1/support/auto-reply-policies/billing')).toBe(false);
  });

  it('gives admins the full surface and denies unknown routes to non-admins', () => {
    expect(isAllowed('admin', 'GET', '/api/v1/system/config')).toBe(true);
    expect(isAllowed('admin', 'POST', '/api/v1/models/m1/promote')).toBe(true);
    expect(isAllowed('agent', 'GET', '/api/v1/not-a-route')).toBe(false);
    expect(ruleFor('GET', '/api/v1/not-a-route').roles).toEqual(['admin']);
  });
});

describe('secret redaction', () => {
  it('redacts secret-looking keys recursively and leaves identifiers intact', () => {
    expect(
      redactValue({
        AUTH_JWT_SECRET: 'abc',
        modules: {
          github: {
            token: 'ghp_x',
            webhookUrl: 'https://example.dev/hook',
            repository: 'org/repo',
          },
        },
        list: [{ password: 'p' }, { name: 'visible' }],
      }),
    ).toEqual({
      AUTH_JWT_SECRET: '[redacted]',
      modules: {
        github: { token: '[redacted]', webhookUrl: '[redacted]', repository: 'org/repo' },
      },
      list: [{ password: '[redacted]' }, { name: 'visible' }],
    });
  });
});
