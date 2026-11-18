import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { isAllowed } from '../src/platform/auth/rbac.js';
import { createMcpGuard, deriveRegisteredName } from '../src/services/mcp.js';
import type { McpConnection } from '../src/services/mcp.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const stdioFixture = fileURLToPath(
  new URL('../../../packages/kernel/test/fixtures/mcp-server.mjs', import.meta.url),
);
type App = FastifyInstance & { kernel?: Kernel };

interface ConnectionView {
  id: string;
  tools: Array<{
    name: string;
    registeredName: string;
    completed: boolean;
    enabled: boolean;
  }>;
}

interface ImportResponse {
  connectionId: string;
  imported: Array<{ remoteName: string; enabled: boolean; risk: string }>;
  tools: ConnectionView['tools'];
}

interface CompleteResponse {
  connectionId: string;
  registered: string[];
  tools: ConnectionView['tools'];
}

describe('MCP tool naming', () => {
  it('maps arbitrary MCP names to the kernel verb grammar', () => {
    expect(deriveRegisteredName('abcd1234-0000-0000-0000-000000000000', 'get_deal')).toBe(
      'mcp.get_deal_abcd1234',
    );
    expect(deriveRegisteredName('abcd1234-0000-0000-0000-000000000000', 'echo')).toBe(
      'mcp.run_echo_abcd1234',
    );
    expect(deriveRegisteredName('abcd1234-0000-0000-0000-000000000000', 'summarize')).toBe(
      'mcp.run_summarize_abcd1234',
    );
    expect(deriveRegisteredName('abcd1234-0000-0000-0000-000000000000', '!!!')).toBeNull();
  });
});

describe('MCP connection RBAC', () => {
  it('keeps connection administration and the inbound edge admin-only', () => {
    for (const [method, path] of [
      ['GET', '/api/v1/mcp/connections'],
      ['POST', '/api/v1/mcp/connections'],
      ['POST', '/api/v1/mcp/connections/x/import'],
      ['POST', '/api/v1/mcp/connections/x/complete'],
      ['POST', '/api/v1/mcp'],
    ] as const) {
      expect(isAllowed('admin', method, path)).toBe(true);
      expect(isAllowed('agent', method, path)).toBe(false);
      expect(isAllowed('customer', method, path)).toBe(false);
    }
  });
});

describeIfDb('MCP connections and enforcement (phase 15.T4/18.T6)', () => {
  let app: App;
  let server: Server;
  let httpUrl = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: number;
          method: string;
          params?: { name?: string };
        };
        response.setHeader('content-type', 'application/json');
        if (body.method === 'initialize') {
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: { protocolVersion: '2025-03-26' },
            }),
          );
          return;
        }
        if (body.method === 'tools/list') {
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                tools: [
                  { name: 'get_deal', description: 'Read a deal from the HTTP fixture CRM.' },
                  { name: 'create_deal', description: 'Create a deal in the HTTP fixture CRM.' },
                  {
                    name: 'run_generation',
                    description: 'Generate a summary with the HTTP fixture model.',
                  },
                ],
              },
            }),
          );
          return;
        }
        const name = body.params?.name ?? 'unknown';
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { content: [{ type: 'text', text: `http:${name}` }] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    httpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    app = (await buildApp({ quiet: true, setup: false, authMode: 'disabled' })) as App;
    await app.kernel!.database.query(`DELETE FROM settings WHERE key = 'mcp.connections'`);
    // Other suites share this database; start from a known control state.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: false, llmDisabled: false, agentsPaused: false },
    });
  });

  afterEach(async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: false, llmDisabled: false, agentsPaused: false },
    });
  });

  afterAll(async () => {
    await app.kernel!.database.query(`DELETE FROM settings WHERE key = 'mcp.connections'`);
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function createConnection(payload: Record<string, unknown>): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp/connections',
      payload,
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { id: string }).id;
  }

  async function importTools(id: string): Promise<ImportResponse> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/connections/${id}/import`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ImportResponse;
  }

  async function complete(
    id: string,
    tools: Array<Record<string, unknown>>,
  ): Promise<CompleteResponse> {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/connections/${id}/complete`,
      payload: { tools },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as CompleteResponse;
  }

  async function inbound(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
    error?: { code?: number; message?: string };
  }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { code?: number; message?: string };
    };
  }

  it('rejects a non-allowlisted HTTP host through the egress client and audits it', async () => {
    const id = await createConnection({
      name: 'Blocked MCP',
      transport: 'http',
      url: httpUrl,
      allowHost: false,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/connections/${id}/import`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'POLICY_BLOCKED' });

    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'egress.denied'`,
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it('the client guard blocks writes, generation and paused calls with an audit row', async () => {
    const connection: McpConnection = {
      id: 'guard-fixture',
      name: 'Guard fixture',
      transport: 'http',
      url: null,
      allowHost: false,
      headers: {},
      command: null,
      args: [],
      env: {},
      createdAt: new Date().toISOString(),
      importedAt: null,
      tools: [],
    };
    const guard = createMcpGuard(app.kernel!, connection, 'tester');

    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: true },
    });
    await expect(
      guard({ server: connection.id, operation: 'callTool', tool: 'create_deal', access: 'write' }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    await expect(
      guard({ server: connection.id, operation: 'callTool', tool: 'get_deal', access: 'read' }),
    ).resolves.toBeUndefined();

    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: false, llmDisabled: true },
    });
    await expect(
      guard({
        server: connection.id,
        operation: 'callTool',
        tool: 'run_generation',
        access: 'read',
        generation: true,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });

    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { llmDisabled: false, agentsPaused: true },
    });
    await expect(
      guard({ server: connection.id, operation: 'callTool', tool: 'get_deal', access: 'read' }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });

    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'mcp.denied' AND subject = $1`,
      [connection.id],
    );
    expect(audit.length).toBeGreaterThanOrEqual(3);
  });

  it('imports disabled tools, completes a read contract and calls it inbound', async () => {
    const id = await createConnection({
      name: 'HTTP Fixture',
      transport: 'http',
      url: httpUrl,
      allowHost: true,
    });
    const imported = await importTools(id);
    expect(imported.imported.find((tool) => tool.remoteName === 'get_deal')).toMatchObject({
      enabled: false,
      risk: 'high',
    });
    const pending = imported.tools.find((tool) => tool.name === 'get_deal');
    expect(pending).toMatchObject({ completed: false, enabled: false });
    expect(pending?.registeredName).toMatch(/^mcp\.get_deal_/);

    const completed = await complete(id, [
      {
        name: 'get_deal',
        description: 'Read a deal from the HTTP fixture CRM.',
        scopes: ['crm:read'],
        access: 'read',
      },
    ]);
    expect(completed.registered).toEqual([pending!.registeredName]);
    expect(completed.tools.find((tool) => tool.name === 'get_deal')).toMatchObject({
      completed: true,
      enabled: true,
    });

    const listed = await app.inject({ method: 'GET', url: '/api/v1/mcp/connections' });
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { connections: ConnectionView[] }).connections
        .find((connection) => connection.id === id)
        ?.tools.find((tool) => tool.name === 'get_deal'),
    ).toMatchObject({ completed: true, enabled: true });

    const tools = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    });
    const toolNames = (
      tools.json() as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((tool) => tool.name);
    expect(toolNames).toContain(pending!.registeredName);

    const called = await inbound(pending!.registeredName, { id: 'd1' });
    expect(called.result?.isError).toBe(false);
    expect(called.result?.content?.[0]?.text).toContain('http:get_deal');
  });

  it('rejects an incomplete contract before registering anything', async () => {
    const id = await createConnection({
      name: 'HTTP Invalid Contract',
      transport: 'http',
      url: httpUrl,
      allowHost: true,
    });
    const imported = await importTools(id);
    const pending = imported.tools.find((tool) => tool.name === 'get_deal');
    expect(pending).toBeDefined();

    const shortDescription = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/connections/${id}/complete`,
      payload: {
        tools: [{ name: 'get_deal', description: 'short', scopes: ['crm:read'] }],
      },
    });
    expect(shortDescription.statusCode).toBe(400);

    const lowRiskWrite = await app.inject({
      method: 'POST',
      url: `/api/v1/mcp/connections/${id}/complete`,
      payload: {
        tools: [
          {
            name: 'create_deal',
            description: 'Create a deal in the HTTP fixture CRM.',
            scopes: ['crm:write'],
            access: 'write',
            risk: 'low',
            enabled: true,
          },
        ],
      },
    });
    expect(lowRiskWrite.statusCode).toBe(400);
    expect(app.kernel!.tools.get(pending!.registeredName)).toBeUndefined();
  });

  it('never auto-enables writes; an enabled write still needs approval and readOnly blocks it', async () => {
    const id = await createConnection({
      name: 'HTTP Writes',
      transport: 'http',
      url: httpUrl,
      allowHost: true,
    });
    const imported = await importTools(id);
    const writeTool = imported.tools.find((tool) => tool.name === 'create_deal');
    expect(writeTool).toBeDefined();

    const contract = {
      name: 'create_deal',
      description: 'Create a deal in the HTTP fixture CRM.',
      scopes: ['crm:write'],
      access: 'write',
    };
    const disabled = await complete(id, [contract]);
    expect(disabled.registered).toEqual([]);
    expect(disabled.tools.find((tool) => tool.name === 'create_deal')).toMatchObject({
      completed: true,
      enabled: false,
    });

    const enabled = await complete(id, [{ ...contract, enabled: true }]);
    expect(enabled.registered).toEqual([writeTool!.registeredName]);

    const unapproved = await inbound(writeTool!.registeredName, { name: 'Acme' });
    expect(unapproved.result?.isError).toBe(true);
    expect(unapproved.result?.content?.[0]?.text).toContain('tool.APPROVAL_REQUIRED');

    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { readOnly: true },
    });
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: writeTool!.registeredName, arguments: { name: 'Acme' } },
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'POLICY_BLOCKED' });
    expect(denied.body).toContain('read_only');
    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action = 'mcp.denied' AND subject = $1`,
      [writeTool!.registeredName],
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it('llmDisabled blocks generation tools and agentsPaused blocks calls', async () => {
    const id = await createConnection({
      name: 'HTTP Generation',
      transport: 'http',
      url: httpUrl,
      allowHost: true,
    });
    const imported = await importTools(id);
    const generation = imported.tools.find((tool) => tool.name === 'run_generation');
    expect(generation).toBeDefined();
    const completed = await complete(id, [
      {
        name: 'run_generation',
        description: 'Generate a summary with the HTTP fixture model.',
        scopes: ['llm:generate'],
        access: 'read',
        generation: true,
      },
    ]);
    expect(completed.registered).toEqual([generation!.registeredName]);

    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { llmDisabled: true },
    });
    const llmDenied = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: generation!.registeredName, arguments: { prompt: 'hi' } },
      },
    });
    expect(llmDenied.statusCode).toBe(403);
    expect(llmDenied.body).toContain('llm_disabled');

    await app.inject({
      method: 'PUT',
      url: '/api/v1/system/controls',
      payload: { llmDisabled: false, agentsPaused: true },
    });
    const paused = await app.inject({
      method: 'POST',
      url: '/api/v1/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: generation!.registeredName, arguments: { prompt: 'hi' } },
      },
    });
    expect(paused.statusCode).toBe(403);
    expect(paused.body).toContain('agents_paused');
  });

  it('imports and calls a stdio MCP server', async () => {
    const id = await createConnection({
      name: 'Stdio Fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    const imported = await importTools(id);
    expect(imported.imported.map((tool) => tool.remoteName)).toContain('get_deal');
    const pending = imported.tools.find((tool) => tool.name === 'get_deal');
    const completed = await complete(id, [
      {
        name: 'get_deal',
        description: 'Read a deal from the fixture CRM.',
        scopes: ['crm:read'],
        access: 'read',
      },
    ]);
    expect(completed.registered).toEqual([pending!.registeredName]);
    const called = await inbound(pending!.registeredName, { id: 'd1' });
    expect(called.result?.isError).toBe(false);
    expect(called.result?.content?.[0]?.text).toContain('ok:get_deal');
  });
});
