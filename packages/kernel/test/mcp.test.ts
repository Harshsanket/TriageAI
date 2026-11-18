import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { policyBlocked } from '../src/errors.js';
import { McpHttpClient, McpStdioClient } from '../src/tools/mcp.js';
import type { McpGuardContext } from '../src/tools/mcp.js';

let server: Server;
let baseUrl: string;
const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id: number;
        method: string;
        params?: { name?: string };
      };
      res.setHeader('content-type', 'application/json');
      if (body.method === 'initialize') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-03-26' },
          }),
        );
        return;
      }
      if (body.method === 'tools/list') {
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'get_deal', description: 'Read a deal from the CRM.' }] },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('MCP HTTP client (phase 15)', () => {
  it('initializes, lists, calls and imports disabled tools', async () => {
    const client = new McpHttpClient(baseUrl);
    expect((await client.initialize()).protocolVersion).toBe('2025-03-26');
    const tools = await client.listTools();
    expect(tools[0]?.name).toBe('get_deal');
    expect(await client.callTool('get_deal', { id: 'd1' })).toMatchObject({
      content: expect.any(Array),
    });

    const imported = client.importTools('crm', tools);
    expect(imported[0]).toMatchObject({
      name: 'mcp.crm.get_deal',
      remoteName: 'get_deal',
      enabled: false,
      imported: 'mcp',
      risk: 'high',
    });
  });

  it('runs the guard before any request and passes the call labels', async () => {
    const seen: McpGuardContext[] = [];
    let fetched = 0;
    const allowed = new McpHttpClient(baseUrl, {}, 1_000, {
      guard: (context) => {
        seen.push(context);
      },
      fetch: async (url, init) => {
        fetched += 1;
        return fetch(url, init);
      },
    });
    await allowed.callTool('get_deal', {}, { access: 'read' });
    expect(seen.at(-1)).toMatchObject({
      operation: 'callTool',
      tool: 'get_deal',
      access: 'read',
    });

    const denied = new McpHttpClient(baseUrl, {}, 1_000, {
      guard: () => {
        throw policyBlocked('read-only mode blocks writes');
      },
      fetch: async (url, init) => {
        fetched += 1;
        return fetch(url, init);
      },
    });
    await expect(denied.callTool('get_deal', {})).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
    expect(fetched).toBe(1);
  });
});

describe('MCP stdio client (phase 15.T4)', () => {
  it('initializes, lists, calls and imports disabled tools over newline JSON-RPC', async () => {
    const stderr: string[] = [];
    const client = new McpStdioClient({
      command: process.execPath,
      args: [fixture],
      env: { FIXTURE_VALUE: 'from-env' },
      timeoutMs: 2_000,
      onStderr: (line) => stderr.push(line),
    });
    try {
      expect((await client.initialize()).protocolVersion).toBe('2025-03-26');
      const tools = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('get_deal');
      expect(await client.callTool('get_deal', { id: 'd1' })).toMatchObject({
        content: [{ type: 'text', text: 'ok:get_deal' }],
      });
      expect(await client.callTool('env_value', {})).toMatchObject({
        content: [{ type: 'text', text: 'from-env' }],
      });

      const imported = client.importTools('crm', tools);
      expect(imported[0]).toMatchObject({
        name: 'mcp.crm.get_deal',
        enabled: false,
        imported: 'mcp',
        risk: 'high',
      });

      await vi.waitFor(() => expect(stderr).toContain('mcp fixture ready'));
    } finally {
      await client.close();
    }
  });

  it('times out a request without killing the transport', async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 100,
    });
    try {
      await expect(client.callTool('slow_tool', {})).rejects.toMatchObject({
        code: 'mcp.TIMEOUT',
        category: 'timeout',
      });
      // The process is still healthy; a later request succeeds.
      expect((await client.listTools()).length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('fails pending and later requests when the server exits', async () => {
    const client = new McpStdioClient({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 2_000,
    });
    try {
      await client.initialize();
      await expect(client.callTool('crash_tool', {})).rejects.toMatchObject({
        code: 'mcp.PROCESS_EXITED',
      });
      await expect(client.listTools()).rejects.toMatchObject({
        code: 'mcp.PROCESS_EXITED',
      });
    } finally {
      await client.close();
    }
  });
});
