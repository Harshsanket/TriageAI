import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { registerPreferenceRoutes } from '../src/routes/preferences.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const USERS = ['prefs-user-a', 'prefs-user-b'];

describeIfDb('appearance preferences (phase 20.7)', () => {
  let app: FastifyInstance;
  let database: PostgresDatabase;

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await database.query(`DELETE FROM user_preferences WHERE user_id = ANY($1)`, [USERS]);
    const kernel = { database } as unknown as Kernel;
    app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const userId = String(request.headers['x-test-user'] ?? USERS[0]);
      request.principal = {
        userId,
        email: `${userId}@test`,
        role: 'customer',
        sessionId: null,
        authenticated: true,
      };
    });
    registerPreferenceRoutes(app, kernel);
    await app.ready();
  });

  afterAll(async () => {
    await database.query(`DELETE FROM user_preferences WHERE user_id = ANY($1)`, [USERS]);
    await app.close();
    await database.close();
  });

  it('stores preferences per user and never leaks them', async () => {
    const first = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences',
      headers: { 'x-test-user': USERS[0] },
      payload: { theme: 'dark', fontSize: 'xlarge', motion: 'off' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences',
      headers: { 'x-test-user': USERS[1] },
      payload: { theme: 'light', fontSize: 'small', motion: 'on' },
    });
    expect(second.statusCode).toBe(200);

    const readFirst = await app.inject({
      method: 'GET',
      url: '/api/v1/me/preferences',
      headers: { 'x-test-user': USERS[0] },
    });
    expect(readFirst.json()).toMatchObject({
      preferences: { theme: 'dark', fontSize: 'xlarge', motion: 'off' },
    });
    const readSecond = await app.inject({
      method: 'GET',
      url: '/api/v1/me/preferences',
      headers: { 'x-test-user': USERS[1] },
    });
    expect(readSecond.json()).toMatchObject({
      preferences: { theme: 'light', fontSize: 'small', motion: 'on' },
    });
  });

  it('remembers the chat sidebar toggle (23.3)', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences',
      headers: { 'x-test-user': USERS[0] },
      payload: { chatSidebar: true },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ preferences: { chatSidebar: true } });

    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/me/preferences',
      headers: { 'x-test-user': USERS[0] },
    });
    expect(read.json()).toMatchObject({ preferences: { chatSidebar: true } });

    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences',
      headers: { 'x-test-user': USERS[0] },
      payload: { chatSidebar: false },
    });
    expect(cleared.json()).toMatchObject({ preferences: { chatSidebar: false } });
  });

  it('rejects duplicate agent names', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/preferences',
      headers: { 'x-test-user': USERS[0] },
      payload: {
        agents: [
          { id: 'a', displayName: 'Voyager', color: '#3b6fd4' },
          { id: 'b', displayName: 'voyager', color: '#d9730d' },
        ],
      },
    });
    expect(res.statusCode).toBe(409);
  });
});
