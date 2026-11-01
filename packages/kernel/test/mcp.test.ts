import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { McpHttpClient } from '../src/tools/mcp.js';

let server: Server;
let baseUrl: string;

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

describe('MCP client (phase 15)', () => {
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
      enabled: false,
      imported: 'mcp',
      risk: 'high',
    });
  });
});
