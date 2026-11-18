import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

import { z } from 'zod';

import { buildApp } from '../src/app.js';
import { setConnectorSecretReader } from '../src/services/connectors.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

describeIfDb('connectors (15.T7)', () => {
  let app: App;
  let server: Server;
  let tokenEndpoint = '';
  let connectionId = '';
  const suffix = Date.now().toString(36);
  const namespace = `gql${suffix}`;

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === '/token') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: 'access-token',
            token_type: 'Bearer',
            refresh_token: 'refresh-token',
            expires_in: 3600,
            scope: 'read',
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    tokenEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
    app = (await buildApp({ quiet: true, setup: false, authMode: 'disabled' })) as App;
  });

  afterAll(async () => {
    // Keep the shared test database clean for other files: connector records,
    // sync watermarks and pending OAuth states are test-local state.
    await app.kernel?.database
      .query(
        `DELETE FROM settings
          WHERE key = 'connector.connections'
             OR key LIKE 'connector.sync.%'
             OR key LIKE 'connector.oauth.%'`,
      )
      .catch(() => undefined);
    setConnectorSecretReader(null);
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('imports GraphQL reads disabled and registers a completed contract', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        name: `CRM ${suffix}`,
        kind: 'graphql',
        namespace,
        endpoint: 'http://127.0.0.1:9/graphql',
        operations: [
          {
            name: 'GetDeal',
            kind: 'query',
            document: 'query GetDeal($id: ID!) { deal(id: $id) { id name } }',
          },
          {
            name: 'CreateDeal',
            kind: 'mutation',
            document: 'mutation CreateDeal($name: String!) { createDeal(name: $name) { id } }',
          },
        ],
      },
    });
    expect(created.statusCode).toBe(200);
    connectionId = (created.json() as { id: string }).id;

    const imported = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${connectionId}/import`,
      payload: {},
    });
    expect(imported.statusCode).toBe(200);
    const importedBody = imported.json() as {
      tools: Array<{ name: string; access: string; enabled: boolean; completed: boolean }>;
    };
    expect(importedBody.tools).toHaveLength(2);
    expect(importedBody.tools.every((tool) => tool.enabled === false)).toBe(true);
    expect(importedBody.tools.find((tool) => tool.access === 'write')?.name).toBe(
      `${namespace}.create_deal`,
    );

    const completed = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${connectionId}/complete`,
      payload: {
        tools: [
          {
            name: `${namespace}.get_deal`,
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
            outputSchema: { type: 'object' },
            enabled: true,
          },
        ],
      },
    });
    expect(completed.statusCode).toBe(200);
    expect((completed.json() as { registered: string[] }).registered).toEqual([
      `${namespace}.get_deal`,
    ]);
    expect(app.kernel?.tools.get(`${namespace}.get_deal`)?.access).toBe('read');
    // Writes stay disabled until explicitly enabled with allowWrites.
    expect(app.kernel?.tools.get(`${namespace}.create_deal`)).toBeUndefined();

    const list = await app.inject({ method: 'GET', url: '/api/v1/connectors' });
    expect(list.statusCode).toBe(200);
    const view = (list.json() as { connections: Array<{ id: string; status: string }> })
      .connections;
    expect(view.find((entry) => entry.id === connectionId)?.status).toBe('ready');
  });

  it('syncs a read-only tool into a watermark and managed source', async () => {
    const toolName = `sql.list_sync_${suffix}`;
    app.kernel?.tools.register({
      name: toolName,
      version: '1.0.0',
      owner: 'test',
      description: 'List sync rows for the connector sync test.',
      examples: [{}],
      input: z.object({}).strict(),
      output: z.object({ rows: z.array(z.object({ id: z.string() })) }).strict(),
      access: 'read',
      risk: 'low',
      scopes: [`${toolName}:read`],
      egressClass: 'internal',
      idempotent: true,
      timeoutMs: 1_000,
      undo: 'free',
      retry: { maxAttempts: 0, backoff: 'none', retryOn: [] },
      handler: async () => ({ rows: [{ id: 'deal-1' }] }),
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        name: `Sync ${suffix}`,
        kind: 'sql',
        dialect: 'postgres',
        sync: {
          enabled: true,
          tool: toolName,
          managedKey: 'deals',
          title: 'CRM deals',
        },
      },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;
    const synced = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${id}/sync`,
    });
    expect(synced.statusCode).toBe(200);
    const body = synced.json() as { synced: number; outcomes: Array<{ rows: number }> };
    expect(body.synced).toBe(1);
    expect(body.outcomes[0]?.rows).toBe(1);
    const watermark = await app.kernel?.database.query<{ value: { rows: number } }>(
      `SELECT value FROM settings WHERE key = $1`,
      [`connector.sync.${id}`],
    );
    expect(watermark?.[0]?.value.rows).toBe(1);
  });

  it('runs authorization-code + PKCE and stores tokens server-side', async () => {
    const secrets = new Map<string, string>();
    setConnectorSecretReader({
      get: async (name) => secrets.get(name) ?? null,
      set: async (name, value) => {
        secrets.set(name, value);
      },
      delete: async (name) => secrets.delete(name),
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: {
        name: `OAuth ${suffix}`,
        kind: 'graphql',
        namespace: `oauth${suffix}`,
        endpoint: 'http://127.0.0.1:9/graphql',
        oauth: {
          authorizationEndpoint: 'http://127.0.0.1:9/authorize',
          tokenEndpoint,
          clientId: 'client-id',
          redirectUri: 'http://127.0.0.1:9/callback',
        },
      },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;
    const started = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${id}/oauth/start`,
    });
    expect(started.statusCode).toBe(200);
    const { authorizeUrl, state } = started.json() as { authorizeUrl: string; state: string };
    expect(authorizeUrl).toContain('code_challenge_method=S256');
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/connectors/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(callback.statusCode).toBe(200);
    expect((callback.json() as { status: string }).status).toBe('ready');
    const stored = [...secrets.values()][0];
    expect(stored).toContain('access-token');
    const list = await app.inject({ method: 'GET', url: '/api/v1/connectors' });
    const view = (list.json() as { connections: Array<{ id: string; status: string }> })
      .connections;
    expect(view.find((entry) => entry.id === id)?.status).toBe('ready');
  });

  it('rejects a SQL connector whose queries interpolate values', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/connectors',
      payload: { name: `Warehouse ${suffix}`, kind: 'sql', dialect: 'postgres' },
    });
    expect(created.statusCode).toBe(200);
    const id = (created.json() as { id: string }).id;
    const imported = await app.inject({
      method: 'POST',
      url: `/api/v1/connectors/${id}/import`,
      payload: {
        queries: [
          {
            name: 'listDeals',
            verb: 'list',
            sql: 'SELECT * FROM deals WHERE owner = ${owner}',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
          },
        ],
      },
    });
    expect(imported.statusCode).toBeGreaterThanOrEqual(400);
  });
});
