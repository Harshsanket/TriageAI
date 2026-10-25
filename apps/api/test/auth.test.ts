import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import { buildApp } from '../src/app.js';
import { config } from '../src/platform/config.js';
import { AuthService } from '../src/platform/auth/service.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

type App = FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };

describeIfDb('auth, sessions and RBAC (phase 9)', () => {
  let app: App;
  let service: AuthService;
  let admin: { email: string; password: string };
  let agent: { email: string; password: string };
  let customer: { email: string; password: string };
  const suffix = ulid().toLowerCase();

  async function login(email: string, password: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; role: string };
    };
  }

  beforeAll(async () => {
    app = (await buildApp({ quiet: true, authMode: 'required', rateLimit: { max: 0 } })) as App;
    service = new AuthService(app.kernel!.database, {
      accessTtlSeconds: config.authAccessTtlSeconds,
      refreshTtlSeconds: config.authRefreshTtlSeconds,
      jwtSecret: config.authJwtSecret,
    });
    admin = { email: `auth-admin-${suffix}@test.dev`, password: 'admin-password-123' };
    agent = { email: `auth-agent-${suffix}@test.dev`, password: 'agent-password-123' };
    customer = { email: `auth-customer-${suffix}@test.dev`, password: 'customer-password-123' };
    await service.createUser({ ...admin, name: 'Admin', role: 'admin', actor: 'test' });
    await service.createUser({ ...agent, name: 'Agent', role: 'agent', actor: 'test' });
    await service.createUser({ ...customer, name: 'Customer', role: 'customer', actor: 'test' });
  });

  afterAll(async () => {
    await app.kernel!.database.query(`DELETE FROM users WHERE email LIKE $1`, [
      `auth-%-${suffix}@test.dev`,
    ]);
    await app.close();
  });

  it('rejects unauthenticated access to guarded routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ title: 'auth.UNAUTHENTICATED' });
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('rejects bad credentials without revealing which field was wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: admin.email, password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ title: 'auth.INVALID_CREDENTIALS' });
  });

  it('closes registration once an account exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: `auth-late-${suffix}@test.dev`,
        password: 'late-password-123',
        name: 'Late',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ title: 'auth.REGISTRATION_CLOSED' });
  });

  it('returns the current user for a valid access token', async () => {
    const session = await login(admin.email, admin.password);
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { email: admin.email, role: 'admin' } });
  });

  it('enforces the role matrix on real routes', async () => {
    const adminSession = await login(admin.email, admin.password);
    const agentSession = await login(agent.email, agent.password);
    const customerSession = await login(customer.email, customer.password);

    const configAsCustomer = await app.inject({
      method: 'GET',
      url: '/api/v1/system/config',
      headers: { authorization: `Bearer ${customerSession.accessToken}` },
    });
    expect(configAsCustomer.statusCode).toBe(403);

    const runsAsCustomer = await app.inject({
      method: 'GET',
      url: '/api/v1/system/runs',
      headers: { authorization: `Bearer ${customerSession.accessToken}` },
    });
    expect(runsAsCustomer.statusCode).toBe(403);

    const runsAsAgent = await app.inject({
      method: 'GET',
      url: '/api/v1/system/runs?limit=1',
      headers: { authorization: `Bearer ${agentSession.accessToken}` },
    });
    expect(runsAsAgent.statusCode).toBe(200);

    const promoteAsAgent = await app.inject({
      method: 'POST',
      url: '/api/v1/models/not-real/promote',
      headers: { authorization: `Bearer ${agentSession.accessToken}` },
      payload: {},
    });
    expect(promoteAsAgent.statusCode).toBe(403);

    const configAsAdmin = await app.inject({
      method: 'GET',
      url: '/api/v1/system/config',
      headers: { authorization: `Bearer ${adminSession.accessToken}` },
    });
    expect(configAsAdmin.statusCode).toBe(200);
    expect(configAsAdmin.json()).toMatchObject({ profile: expect.any(String) });
  });

  it('rotates refresh tokens and revokes the family on replay', async () => {
    const first = await login(customer.email, customer.password);
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json() as { refreshToken: string };

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: first.refreshToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ title: 'auth.REFRESH_REPLAY' });

    const afterReplay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: second.refreshToken },
    });
    expect(afterReplay.statusCode).toBe(401);
  });

  it('revokes the session on logout', async () => {
    const session = await login(customer.email, customer.password);
    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: session.refreshToken },
    });
    expect(loggedOut.statusCode).toBe(200);
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describeIfDb('rate limiting (phase 9)', () => {
  it('returns 429 after the configured burst', async () => {
    const app = (await buildApp({
      quiet: true,
      authMode: 'disabled',
      rateLimit: { max: 2, timeWindow: '1 minute' },
    })) as App;
    try {
      await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      const third = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      expect(third.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
