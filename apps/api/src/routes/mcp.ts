/**
 * MCP edge adapter (ADR-0055 §5): outside agents call TriageAI tools through
 * the same tool registry, validation and scopes as internal stages.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';

import { invalid, notFound } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

const RpcSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1).max(100),
    params: z.unknown().optional(),
  })
  .strict();

export function registerMcpRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/mcp/card', async () => ({
    name: 'TriageAI',
    description: 'TriageAI tools exposed over MCP',
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    tools: kernel.tools.list().map((tool) => tool.name),
  }));

  app.post('/api/v1/mcp', async (request) => {
    const rpc = RpcSchema.parse(request.body ?? {});
    const reply = (result: unknown) => ({ jsonrpc: '2.0' as const, id: rpc.id ?? null, result });
    const fail = (code: number, message: string) => ({
      jsonrpc: '2.0' as const,
      id: rpc.id ?? null,
      error: { code, message },
    });

    switch (rpc.method) {
      case 'initialize':
        return reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'triageai', version: '1.0.0' },
        });
      case 'tools/list':
        return reply({
          tools: kernel.tools.list().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: { type: 'object' },
          })),
        });
      case 'tools/call': {
        const params = z
          .object({ name: z.string().min(1), arguments: z.unknown().optional() })
          .strict()
          .parse(rpc.params ?? {});
        const tool = kernel.tools.get(params.name);
        if (!tool) throw notFound(`tool ${params.name} is not registered`);
        const result = await kernel.tools.invoke(
          params.name,
          params.arguments ?? {},
          {
            runId: `mcp:${ulid()}`,
            stepId: params.name,
            grantedScopes: tool.scopes,
            egressClass: 'internal',
            org: { ownsEmail: () => false },
            logger: request.log,
          },
          { approved: false },
        );
        return reply({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: !result.ok,
        });
      }
      default:
        return fail(-32601, `method not found: ${rpc.method}`);
    }
  });
}

export function assertSupportedMethod(method: string): void {
  if (!['initialize', 'tools/list', 'tools/call'].includes(method)) {
    throw invalid(`unsupported MCP method ${method}`);
  }
}
