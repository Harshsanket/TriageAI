import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('connected APIs (phase 23.7)', () => {
  let app: FastifyInstance;
  let id = '';

  beforeAll(async () => {
    app = await buildApp({ quiet: true, setup: false, authMode: 'disabled' });
  });

  afterAll(async () => {
    if (id) await app.inject({ method: 'DELETE', url: `/api/v1/connections/${id}` });
    await app.close();
  });

  it('adds a connection with a secret, lists it and rotates the secret', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connections',
      payload: {
        name: 'Test API',
        type: 'custom',
        baseUrl: 'https://example.org',
        secretName: 'TEST_CONNECTION_TOKEN',
        secretValue: 'secret-value',
        allowHost: false,
      },
    });
    expect(created.statusCode).toBe(200);
    id = (created.json() as { id: string }).id;

    const listed = await app.inject({ method: 'GET', url: '/api/v1/connections' });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      connections: Array<{ id: string; name: string; secretName: string | null; status: string }>;
    };
    expect(body.connections.find((entry) => entry.id === id)).toMatchObject({
      name: 'Test API',
      secretName: 'TEST_CONNECTION_TOKEN',
      status: 'ready',
    });

    const refusedTest = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${id}/test`,
    });
    expect(refusedTest.statusCode).toBe(400);

    const rotated = await app.inject({
      method: 'PUT',
      url: `/api/v1/connections/${id}/secret`,
      payload: { value: 'rotated-value' },
    });
    expect(rotated.statusCode).toBe(200);

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v1/connections/${id}/disable`,
    });
    expect(disabled.json()).toMatchObject({ disabled: true });
  });
});
