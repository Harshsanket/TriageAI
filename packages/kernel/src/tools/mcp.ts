/**
 * MCP client (Phase 15.T4): streamable HTTP JSON-RPC. Imported tools start
 * disabled because MCP servers rarely provide output schemas/descriptions; an
 * admin must complete the tool contract before enabling them.
 */
import { fetchFailure, httpFailure } from '../errors.js';
import type { ToolInfo } from './types.js';

export interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface ImportedMcpTool extends ToolInfo {
  enabled: false;
  imported: 'mcp';
  server: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export class McpHttpClient {
  private nextId = 1;

  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 10_000,
  ) {}

  private async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw fetchFailure({ codePrefix: 'mcp', label: 'mcp', cause: err });
    }
    const text = await response.text();
    if (!response.ok) {
      throw httpFailure({
        codePrefix: 'mcp',
        label: 'mcp',
        status: response.status,
        body: text,
        retryAfter: response.headers.get('retry-after') ?? undefined,
      });
    }
    const body = JSON.parse(text) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    if (body.error)
      throw new Error(`MCP error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown'}`);
    return body.result;
  }

  async initialize(): Promise<{ protocolVersion?: string; serverInfo?: unknown }> {
    return (await this.rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'triageai', version: '1.0.0' },
    })) as { protocolVersion?: string; serverInfo?: unknown };
  }

  async listTools(): Promise<McpToolDescription[]> {
    const result = (await this.rpc('tools/list')) as { tools?: McpToolDescription[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.rpc('tools/call', { name, arguments: args });
  }

  /** Imported tools are disabled until an admin fills the full contract. */
  importTools(serverId: string, tools: McpToolDescription[]): ImportedMcpTool[] {
    return tools.map((tool) => ({
      name: `mcp.${serverId}.${tool.name}`.slice(0, 64),
      version: '0.0.0',
      owner: `mcp:${serverId}`,
      description: tool.description?.slice(0, 400) ?? 'Imported MCP tool (description required)',
      access: 'read',
      risk: 'high',
      scopes: [],
      timeoutMs: 10_000,
      undo: 'none',
      idempotent: false,
      enabled: false,
      imported: 'mcp',
      server: serverId,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    }));
  }
}
