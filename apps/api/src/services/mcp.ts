/**
 * MCP connection registry (Phase 15.T4): connections live in
 * `settings['mcp.connections']` (no migration), tools are imported disabled and
 * only an admin can complete the contract before they are registered.
 *
 * Every HTTP call goes through the host `EgressClient`; every tool call also
 * carries the 18.5 kill-switch guard so `readOnly`, `llmDisabled` and
 * `agentsPaused` are enforced outside the inbound MCP route too.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Kernel, McpGuard, ToolAccess, ToolDefinition, ToolRisk } from '@triageai/kernel';
import {
  conflict,
  importMcpTools,
  invalid,
  McpHttpClient,
  McpStdioClient,
  notFound,
  policyBlocked,
  validateToolDefinition,
} from '@triageai/kernel';

import { writeAudit } from './audit.js';
import { getControls } from './controls.js';
import { EgressClient } from './egress.js';

export const MCP_CONNECTIONS_KEY = 'mcp.connections';

export interface StoredMcpTool {
  /** Remote name exactly as the server listed it. */
  name: string;
  /** Kernel tool name; derived or supplied when the contract is completed. */
  registeredName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  access: ToolAccess;
  risk: ToolRisk;
  undo: 'free' | 'compensable' | 'none';
  idempotent: boolean;
  scopes: string[];
  enabled: boolean;
  completed: boolean;
  generation: boolean;
  timeoutMs?: number;
}

export interface McpConnection {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  allowHost: boolean;
  headers: Record<string, string>;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  createdAt: string;
  importedAt: string | null;
  tools: StoredMcpTool[];
}

export interface McpConnectionView {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  allowHost: boolean;
  command: string | null;
  args: string[];
  /** Secret values never leave the server; only the configured keys are shown. */
  env: string[];
  headers: string[];
  createdAt: string;
  importedAt: string | null;
  egressAllowlisted: boolean | null;
  tools: StoredMcpTool[];
}

export interface McpConnectionInput {
  name: string;
  transport: 'http' | 'stdio';
  url?: string;
  allowHost: boolean;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export const McpConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    transport: z.enum(['http', 'stdio']).default('http'),
    url: z.string().url().optional(),
    allowHost: z.boolean().default(false),
    headers: z.record(z.string().min(1).max(100), z.string().max(10_000)).optional(),
    command: z.string().trim().min(1).max(500).optional(),
    args: z.array(z.string().max(1_000)).max(50).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10_000)).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.transport === 'http' && !value.url) {
      ctx.addIssue({
        code: 'custom',
        message: 'url is required for HTTP MCP connections',
        path: ['url'],
      });
    }
    if (value.transport === 'http' && value.url) {
      const protocol = new URL(value.url).protocol;
      if (protocol !== 'http:' && protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          message: 'url must use http or https',
          path: ['url'],
        });
      }
    }
    if (value.transport === 'stdio' && !value.command) {
      ctx.addIssue({
        code: 'custom',
        message: 'command is required for stdio MCP connections',
        path: ['command'],
      });
    }
  });

const ToolContractSchema = z
  .object({
    /** Remote tool name from the last import. */
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(10).max(400),
    scopes: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
    access: z.enum(['read', 'write']).optional(),
    risk: z.enum(['low', 'high']).optional(),
    /** Writes are never enabled implicitly. */
    enabled: z.boolean().optional(),
    generation: z.boolean().optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    /** Override when the remote name does not map to the kernel verb grammar. */
    registeredName: z.string().trim().min(3).max(64).optional(),
  })
  .strict();

export const CompleteMcpToolsSchema = z
  .object({ tools: z.array(ToolContractSchema).min(1).max(50) })
  .strict();

export type CompleteMcpToolsInput = z.infer<typeof CompleteMcpToolsSchema>;

/** Same fixed verb set as the kernel tool contract (ADR-0029). */
const KERNEL_VERBS = new Set([
  'get',
  'list',
  'search',
  'query',
  'create',
  'update',
  'delete',
  'send',
  'run',
]);

async function readConnections(kernel: Kernel): Promise<McpConnection[]> {
  const rows = await kernel.database
    .query<{ value: McpConnection[] }>(`SELECT value FROM settings WHERE key = $1`, [
      MCP_CONNECTIONS_KEY,
    ])
    .catch(() => []);
  const value = rows[0]?.value;
  return Array.isArray(value) ? value : [];
}

async function writeConnections(
  kernel: Kernel,
  actor: string | null,
  connections: McpConnection[],
): Promise<void> {
  await kernel.database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [MCP_CONNECTIONS_KEY, connections, actor ?? 'system'],
  );
}

function egressFor(kernel: Kernel, connection: McpConnection): EgressClient {
  const rules = (kernel.config.egress?.allowlist ?? []).map((entry) => ({
    host: entry.host,
    dataClass: entry.dataClass,
  }));
  if (!connection.url) return new EgressClient(kernel.database, rules);
  const host = new URL(connection.url).hostname.toLowerCase();
  // `allowHost` is the explicit admin confirmation from the Connected APIs
  // surface. It also permits a local runtime (e.g. an MCP bridge on localhost)
  // on the first hop; metadata/link-local addresses stay blocked.
  if (connection.allowHost) {
    rules.push({ host, dataClass: 'internal' });
    return new EgressClient(kernel.database, rules, { allowPrivateHosts: [host] });
  }
  return new EgressClient(kernel.database, rules);
}

/**
 * 18.5 kill switches. Import/list are admin setup operations; only tool calls
 * are gated. Every denial is audited before the typed policy error is thrown.
 */
export function createMcpGuard(
  kernel: Kernel,
  connection: McpConnection,
  actor: string | null,
): McpGuard {
  return async (context) => {
    if (context.operation !== 'callTool') return;
    const controls = await getControls(kernel.database);
    const reason =
      controls.readOnly && context.access !== 'read'
        ? 'read_only'
        : controls.llmDisabled && context.generation
          ? 'llm_disabled'
          : controls.agentsPaused
            ? 'agents_paused'
            : null;
    if (!reason) return;
    await writeAudit(kernel.database, {
      actor,
      action: 'mcp.denied',
      subject: connection.id,
      payload: {
        surface: 'outbound',
        operation: context.operation,
        tool: context.tool ?? null,
        reason,
      },
    });
    throw policyBlocked(`MCP tool call denied: ${reason}`);
  };
}

function createClient(
  kernel: Kernel,
  connection: McpConnection,
  actor: string | null,
  guard: McpGuard,
): McpHttpClient | McpStdioClient {
  if (connection.transport === 'stdio') {
    if (!connection.command) throw invalid(`MCP connection ${connection.id} has no command`);
    return new McpStdioClient({
      command: connection.command,
      args: connection.args ?? [],
      env: connection.env ?? {},
      serverId: connection.id,
      guard,
      timeoutMs: 30_000,
    });
  }
  if (!connection.url) throw invalid(`MCP connection ${connection.id} has no URL`);
  const egress = egressFor(kernel, connection);
  return new McpHttpClient(connection.url, connection.headers ?? {}, 30_000, {
    serverId: connection.id,
    guard,
    // The host egress client owns the allowlist, SSRF checks and denial audit.
    fetch: (url, init) =>
      egress.fetch(url, init, { actor, purpose: `mcp.connection:${connection.id}` }),
  });
}

async function closeClient(client: McpHttpClient | McpStdioClient): Promise<void> {
  if (client instanceof McpStdioClient) await client.close();
}

async function listServerTools(
  kernel: Kernel,
  connection: McpConnection,
  actor: string | null,
): Promise<Awaited<ReturnType<McpHttpClient['listTools']>>> {
  const client = createClient(kernel, connection, actor, createMcpGuard(kernel, connection, actor));
  try {
    await client.initialize();
    return await client.listTools();
  } finally {
    await closeClient(client);
  }
}

/** `get_deal` on server `<id>` -> `mcp.get_deal_<short id>`. */
export function deriveRegisteredName(connectionId: string, remoteName: string): string | null {
  const normalized = remoteName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return null;
  const match = /^([a-z][a-z0-9]*)_([a-z0-9_]+)$/.exec(normalized);
  // MCP tool names are arbitrary; the kernel contract needs one of its fixed
  // verbs. Prefer the remote verb when it is known, otherwise use the generic
  // `run` verb (an admin can override `registeredName` for a better name).
  const verb = match && KERNEL_VERBS.has(match[1] as string) ? (match[1] as string) : 'run';
  const object = verb === match?.[1] ? (match?.[2] as string) : normalized;
  const server = connectionId
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  if (!server) return null;
  return `mcp.${verb}_${object}_${server}`.slice(0, 64);
}

function toolDefinition(
  kernel: Kernel,
  connection: McpConnection,
  tool: StoredMcpTool,
): ToolDefinition<Record<string, unknown>, unknown> {
  const host = connection.url ? new URL(connection.url).hostname : null;
  return {
    name: tool.registeredName,
    version: '0.0.0',
    owner: `mcp:${connection.id}`,
    description: tool.description,
    examples: [{}],
    input: z.record(z.string(), z.unknown()),
    output: z.unknown(),
    access: tool.access,
    risk: tool.risk,
    scopes: tool.scopes,
    egressClass: 'internal',
    ...(host ? { allowedHosts: [host] } : {}),
    idempotent: tool.idempotent ?? tool.access === 'read',
    timeoutMs: tool.timeoutMs ?? 30_000,
    undo: tool.undo ?? (tool.access === 'write' ? 'none' : 'free'),
    retry: { maxAttempts: 0, backoff: 'none', retryOn: [] },
    ...(tool.access === 'write'
      ? {
          preview: async () => ({
            summary: `Call MCP tool ${tool.name} on ${connection.name}`,
            affects: [connection.name],
          }),
        }
      : {}),
    ...(tool.generation ? { costHint: 'llm' } : {}),
    handler: async (input, ctx) => {
      const guard = createMcpGuard(kernel, connection, ctx.actorId ?? null);
      const client = createClient(kernel, connection, ctx.actorId ?? null, guard);
      try {
        await client.initialize();
        return await client.callTool(tool.name, input, {
          access: tool.access,
          generation: tool.generation,
        });
      } finally {
        await closeClient(client);
      }
    },
  };
}

function view(kernel: Kernel, connection: McpConnection): McpConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    transport: connection.transport,
    url: connection.url,
    allowHost: connection.allowHost,
    command: connection.command,
    args: connection.args ?? [],
    env: Object.keys(connection.env ?? {}).sort(),
    headers: Object.keys(connection.headers ?? {}).sort(),
    createdAt: connection.createdAt,
    importedAt: connection.importedAt,
    egressAllowlisted: connection.url ? egressFor(kernel, connection).allows(connection.url) : null,
    tools: connection.tools ?? [],
  };
}

export async function listMcpConnections(kernel: Kernel): Promise<McpConnectionView[]> {
  return (await readConnections(kernel)).map((connection) => view(kernel, connection));
}

export async function addMcpConnection(
  kernel: Kernel,
  input: McpConnectionInput,
  actor: string | null,
): Promise<McpConnectionView> {
  const connections = await readConnections(kernel);
  if (
    connections.some((entry) => String(entry.name ?? '').toLowerCase() === input.name.toLowerCase())
  ) {
    throw invalid(`an MCP connection named ${input.name} already exists`);
  }
  const connection: McpConnection = {
    id: randomUUID(),
    name: input.name,
    transport: input.transport,
    url: input.transport === 'http' ? (input.url ?? null) : null,
    allowHost: input.allowHost,
    headers: input.headers ?? {},
    command: input.transport === 'stdio' ? (input.command ?? null) : null,
    args: input.args ?? [],
    env: input.env ?? {},
    createdAt: new Date().toISOString(),
    importedAt: null,
    tools: [],
  };
  await writeConnections(kernel, actor, [...connections, connection]);
  await writeAudit(kernel.database, {
    actor,
    action: 'mcp.connection.created',
    subject: connection.id,
    payload: { name: connection.name, transport: connection.transport },
  });
  return view(kernel, connection);
}

export async function importMcpConnection(
  kernel: Kernel,
  id: string,
  actor: string | null,
): Promise<{
  connectionId: string;
  imported: ReturnType<typeof importMcpTools>;
  tools: StoredMcpTool[];
}> {
  const connections = await readConnections(kernel);
  const connection = connections.find((entry) => entry.id === id);
  if (!connection) throw notFound(`MCP connection ${id} not found`);

  const listed = await listServerTools(kernel, connection, actor);
  const imported = importMcpTools(connection.id, listed);
  const previous = new Map((connection.tools ?? []).map((tool) => [tool.name, tool]));
  const tools: StoredMcpTool[] = imported.map((tool) => {
    const prior = previous.get(tool.remoteName);
    if (prior?.completed) return prior;
    return {
      name: tool.remoteName,
      registeredName: deriveRegisteredName(connection.id, tool.remoteName) ?? '',
      description: tool.description,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      access: 'read',
      risk: 'high',
      undo: 'none',
      idempotent: false,
      scopes: [],
      enabled: false,
      completed: false,
      generation: false,
    };
  });
  connection.tools = tools;
  connection.importedAt = new Date().toISOString();
  await writeConnections(kernel, actor, connections);
  await writeAudit(kernel.database, {
    actor,
    action: 'mcp.connection.imported',
    subject: connection.id,
    payload: { tools: imported.map((tool) => tool.remoteName) },
  });
  return { connectionId: connection.id, imported, tools };
}

function findStoredTool(connection: McpConnection, name: string): StoredMcpTool | undefined {
  return (connection.tools ?? []).find(
    (tool) =>
      tool.name === name ||
      tool.registeredName === name ||
      `mcp.${connection.id}.${tool.name}`.slice(0, 64) === name,
  );
}

export async function completeMcpConnection(
  kernel: Kernel,
  id: string,
  input: CompleteMcpToolsInput,
  actor: string | null,
): Promise<{ connectionId: string; registered: string[]; tools: StoredMcpTool[] }> {
  const connections = await readConnections(kernel);
  const connection = connections.find((entry) => entry.id === id);
  if (!connection) throw notFound(`MCP connection ${id} not found`);

  const updatedByName = new Map((connection.tools ?? []).map((tool) => [tool.name, tool]));
  const definitions: Array<ToolDefinition<Record<string, unknown>, unknown>> = [];

  for (const contract of input.tools) {
    const tool = findStoredTool(connection, contract.name);
    if (!tool) throw notFound(`MCP tool ${contract.name} is not imported on connection ${id}`);
    const access = contract.access ?? tool.access;
    const risk = contract.risk ?? tool.risk;
    const registeredName =
      contract.registeredName ??
      (tool.registeredName || deriveRegisteredName(connection.id, tool.name) || '');
    if (!registeredName) {
      throw invalid(
        `MCP tool ${tool.name} needs an explicit registeredName: the remote name does not map to the kernel verb grammar`,
      );
    }
    const next: StoredMcpTool = {
      ...tool,
      registeredName,
      description: contract.description,
      scopes: contract.scopes,
      access,
      risk,
      undo: access === 'write' ? 'none' : 'free',
      idempotent: access === 'read',
      // Writes are never enabled implicitly; reads become callable once the
      // contract is complete.
      enabled: contract.enabled ?? access === 'read',
      completed: true,
      generation: contract.generation ?? tool.generation,
      ...(contract.timeoutMs === undefined ? {} : { timeoutMs: contract.timeoutMs }),
    };
    updatedByName.set(next.name, next);
    if (!next.enabled) continue;
    const definition = toolDefinition(kernel, connection, next);
    const problems = validateToolDefinition(definition);
    if (problems.length > 0) {
      throw invalid(`invalid contract for MCP tool ${tool.name}`, problems);
    }
    const existing = kernel.tools.get(definition.name);
    if (existing && existing.owner !== definition.owner) {
      throw conflict(`tool ${definition.name} is already registered by ${existing.owner}`);
    }
    definitions.push(definition);
  }

  // Register after validating every contract so one bad row does not leave a
  // half-completed connection in the registry.
  const registered: string[] = [];
  for (const definition of definitions) {
    if (kernel.tools.get(definition.name)) continue;
    kernel.tools.register(definition);
    registered.push(definition.name);
  }

  const updated = [...updatedByName.values()];
  connection.tools = updated;
  await writeConnections(kernel, actor, connections);
  await writeAudit(kernel.database, {
    actor,
    action: 'mcp.connection.completed',
    subject: connection.id,
    payload: { registered, tools: updated.map((tool) => tool.registeredName) },
  });
  return { connectionId: connection.id, registered, tools: updated };
}

/**
 * Re-register completed connections after a boot or soft reload. A stale
 * contract is reported, not fatal: the admin can re-complete it.
 */
export async function restoreMcpTools(
  kernel: Kernel,
): Promise<{ registered: string[]; failed: Array<{ name: string; reason: string }> }> {
  const registered: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const connection of await readConnections(kernel)) {
    for (const tool of connection.tools ?? []) {
      if (!tool.completed || !tool.enabled || !tool.registeredName) continue;
      if (kernel.tools.get(tool.registeredName)) continue;
      try {
        const definition = toolDefinition(kernel, connection, tool);
        const problems = validateToolDefinition(definition);
        if (problems.length > 0) throw new Error(problems.join('; '));
        kernel.tools.register(definition);
        registered.push(definition.name);
      } catch (err) {
        failed.push({ name: tool.registeredName, reason: (err as Error).message });
      }
    }
  }
  return { registered, failed };
}
