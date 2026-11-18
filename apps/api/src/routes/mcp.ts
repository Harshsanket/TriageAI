/**
 * MCP edge adapter (ADR-0055 §5): outside agents call TriageAI tools through
 * the same tool registry, validation and scopes as internal stages. The
 * inbound surface also consults the 18.5 kill switches before dispatch.
 *
 * Admin connection management (15.T4) lives here too: MCP servers are stored
 * in settings, imported disabled and completed before registration.
 */
import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';

import { AppError, invalid, notFound, policyBlocked } from '@triageai/kernel';
import type { Kernel, KernelLogger } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';
import { getControls } from '../services/controls.js';
import {
  addMcpConnection,
  completeMcpConnection,
  CompleteMcpToolsSchema,
  importMcpConnection,
  listMcpConnections,
  McpConnectionInputSchema,
} from '../services/mcp.js';

const RpcSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number(), z.null()]).optional(),
    method: z.string().min(1).max(100),
    params: z.unknown().optional(),
  })
  .strict();

/** Conservative naming convention until the tool contract carries a kind. */
const GENERATION_TOKENS = new Set([
  'generation',
  'generate',
  'summarize',
  'classify',
  'chat',
  'complete',
  'completion',
  'answer',
  'draft',
  'ask',
  'llm',
]);

export function isGenerationTool(tool: { name: string; costHint?: string }): boolean {
  if (tool.costHint?.startsWith('llm')) return true;
  return tool.name
    .toLowerCase()
    .split(/[._]/)
    .some((token) => GENERATION_TOKENS.has(token));
}

export function registerMcpRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/mcp/card', async () => ({
    name: 'TriageAI',
    description: 'TriageAI tools exposed over MCP',
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    tools: kernel.tools.list().map((tool) => tool.name),
  }));

  app.get('/api/v1/mcp/connections', async () => ({
    connections: await listMcpConnections(kernel),
  }));

  app.post('/api/v1/mcp/connections', async (request) => {
    const body = McpConnectionInputSchema.parse(request.body ?? {});
    const connection = await addMcpConnection(kernel, body, request.principal?.email ?? null);
    return { id: connection.id, saved: true, connection };
  });

  app.post('/api/v1/mcp/connections/:id/import', async (request) => {
    const { id } = request.params as { id: string };
    return importMcpConnection(kernel, id, request.principal?.email ?? null);
  });

  app.post('/api/v1/mcp/connections/:id/complete', async (request) => {
    const { id } = request.params as { id: string };
    const body = CompleteMcpToolsSchema.parse(request.body ?? {});
    return completeMcpConnection(kernel, id, body, request.principal?.email ?? null);
  });

  async function handleMcpRpc(
    kernel: Kernel,
    rpc: z.infer<typeof RpcSchema>,
    actor: string | null,
    logger: KernelLogger,
  ): Promise<unknown> {
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

        const controls = await getControls(kernel.database);
        const denial = controls.agentsPaused
          ? 'agents_paused'
          : controls.readOnly && tool.access === 'write'
            ? 'read_only'
            : controls.llmDisabled && isGenerationTool(tool)
              ? 'llm_disabled'
              : null;
        if (denial) {
          await writeAudit(kernel.database, {
            actor,
            action: 'mcp.denied',
            subject: params.name,
            payload: { surface: 'inbound', tool: params.name, reason: denial },
          });
          throw policyBlocked(`MCP tool call denied: ${denial}`);
        }

        const result = await kernel.tools.invoke(
          params.name,
          params.arguments ?? {},
          {
            runId: `mcp:${ulid()}`,
            stepId: params.name,
            ...(actor ? { actorId: actor } : {}),
            grantedScopes: tool.scopes,
            egressClass: 'internal',
            org: { ownsEmail: () => false },
            logger,
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
  }

  app.post('/api/v1/mcp', async (request) =>
    handleMcpRpc(
      kernel,
      RpcSchema.parse(request.body ?? {}),
      request.principal?.email ?? null,
      request.log,
    ),
  );

  // 13.T1: the public-api key surface exposes the same MCP tools. The guard
  // marks this route as key-authenticated; the handler verifies the hash.
  app.post('/api/v1/public-api/mcp', async (request) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      throw new AppError('auth.UNAUTHENTICATED', 'missing API key', undefined, 401, {
        category: 'unauthenticated',
      });
    }
    const hash = createHash('sha256').update(token).digest('hex');
    const rows = await kernel.database.query<{
      id: string;
      scopes: string[];
      revoked_at: string | null;
    }>(`SELECT id, scopes, revoked_at FROM mod_public_api.public_api_keys WHERE key_hash = $1`, [
      hash,
    ]);
    const key = rows[0];
    if (!key || key.revoked_at) {
      throw new AppError('auth.UNAUTHENTICATED', 'invalid or revoked API key', undefined, 401, {
        category: 'unauthenticated',
      });
    }
    if (!key.scopes.includes('chat')) {
      throw policyBlocked('this API key is not allowed to call MCP tools');
    }
    await kernel.database
      .query(`UPDATE mod_public_api.public_api_keys SET last_used_at = now() WHERE id = $1`, [
        key.id,
      ])
      .catch(() => undefined);
    return handleMcpRpc(
      kernel,
      RpcSchema.parse(request.body ?? {}),
      `api-key:${key.id}`,
      request.log,
    );
  });
}

export function assertSupportedMethod(method: string): void {
  if (!['initialize', 'tools/list', 'tools/call'].includes(method)) {
    throw invalid(`unsupported MCP method ${method}`);
  }
}
