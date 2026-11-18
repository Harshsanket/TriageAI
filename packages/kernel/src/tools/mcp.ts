/**
 * MCP client (Phase 15.T4): streamable HTTP and stdio JSON-RPC transports.
 * Imported tools start disabled because MCP servers rarely provide output
 * schemas/descriptions; an admin must complete the tool contract before
 * enabling them.
 *
 * Both transports accept a guard callback. The host passes the 18.5 kill
 * switches through it (read-only / LLM disabled / agents paused) so a client
 * cannot bypass controls just because it speaks a different transport.
 */
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { AppError, fetchFailure, httpFailure } from '../errors.js';
import type { ToolAccess, ToolInfo } from './types.js';

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
  /** The name the MCP server listed; `name` is the namespaced import id. */
  remoteName: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export type McpOperation = 'initialize' | 'listTools' | 'callTool';

export interface McpGuardContext {
  server: string;
  operation: McpOperation;
  tool?: string;
  /** Known contract access for `callTool` (imported tools carry it). */
  access?: ToolAccess;
  /** The tool is known to call a model; `llmDisabled` blocks it. */
  generation?: boolean;
}

/** Throw to deny; the host implementation also writes the audit row. */
export type McpGuard = (context: McpGuardContext) => void | Promise<void>;

export interface McpClientOptions {
  /** Stable server id used in guards/errors (defaults to the URL or command). */
  serverId?: string;
  /** 18.5 kill-switch seam. */
  guard?: McpGuard;
  /**
   * HTTP transport seam. The host passes `EgressClient.fetch` so every MCP
   * request gets the allowlist, SSRF checks and denial audit.
   */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

interface RpcContext {
  operation: McpOperation;
  tool?: string;
  access?: ToolAccess;
  generation?: boolean;
}

export class McpHttpClient {
  private nextId = 1;

  constructor(
    private readonly baseUrl: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 10_000,
    private readonly options: McpClientOptions = {},
  ) {}

  private async rpc(
    method: string,
    params: Record<string, unknown> = {},
    context: RpcContext = { operation: 'initialize' },
  ): Promise<unknown> {
    await this.options.guard?.({
      server: this.options.serverId ?? this.baseUrl,
      ...context,
    });
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.baseUrl, {
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
      // Preserve typed policy/egress failures instead of flattening them into
      // a generic transport error (the host already audited the denial).
      if (err instanceof AppError) throw err;
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
    let body: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new AppError(
        'mcp.INVALID_RESPONSE',
        `MCP server ${this.options.serverId ?? this.baseUrl} returned a non-JSON response`,
        undefined,
        502,
        { category: 'dependency_unavailable', retryable: false },
      );
    }
    if (body.error) {
      throw new AppError(
        'mcp.RPC_ERROR',
        `MCP error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown'}`,
        { code: body.error.code ?? null, method },
        502,
        { category: 'dependency_unavailable', retryable: false },
      );
    }
    return body.result;
  }

  async initialize(): Promise<{ protocolVersion?: string; serverInfo?: unknown }> {
    return (await this.rpc(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'triageai', version: '1.0.0' },
      },
      { operation: 'initialize' },
    )) as { protocolVersion?: string; serverInfo?: unknown };
  }

  async listTools(): Promise<McpToolDescription[]> {
    const result = (await this.rpc('tools/list', {}, { operation: 'listTools' })) as {
      tools?: McpToolDescription[];
    };
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: unknown,
    options: { access?: ToolAccess; generation?: boolean } = {},
  ): Promise<unknown> {
    return this.rpc(
      'tools/call',
      { name, arguments: args },
      {
        operation: 'callTool',
        tool: name,
        ...(options.access ? { access: options.access } : {}),
        ...(options.generation === undefined ? {} : { generation: options.generation }),
      },
    );
  }

  /** Imported tools are disabled until an admin fills the full contract. */
  importTools(serverId: string, tools: McpToolDescription[]): ImportedMcpTool[] {
    return importMcpTools(serverId, tools);
  }
}

export interface McpStdioOptions extends McpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  /** stderr is free-form logs, never protocol data. */
  onStderr?: (line: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * MCP stdio transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. stderr
 * is surfaced as logs, never parsed. Requests are correlated by id and fail
 * on timeout or process exit; a crashed server is not respawned mid-run.
 */
export class McpStdioClient {
  private readonly timeoutMs: number;
  private nextId = 1;
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private readonly stderrLines: string[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private exitError?: AppError;
  private closing = false;

  constructor(private readonly options: McpStdioOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private get serverId(): string {
    return this.options.serverId ?? this.options.command;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    context: RpcContext,
  ): Promise<unknown> {
    await this.options.guard?.({
      server: this.serverId,
      ...context,
    });
    const child = this.ensureChild();
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError(
            'mcp.TIMEOUT',
            `MCP server ${this.serverId} timed out after ${this.timeoutMs}ms on ${method}`,
            undefined,
            504,
            { category: 'timeout', retryable: true },
          ),
        );
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        child.stdin.write(payload, (err) => {
          if (!err) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new AppError(
              'mcp.WRITE_FAILED',
              `could not write to MCP server ${this.serverId}: ${err.message}`,
              undefined,
              502,
              { category: 'dependency_unavailable', retryable: false, cause: err },
            ),
          );
        });
      } catch (err) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new AppError(
              'mcp.WRITE_FAILED',
              `could not write to MCP server ${this.serverId}: ${(err as Error).message}`,
              undefined,
              502,
              { category: 'dependency_unavailable', retryable: false, cause: err },
            ),
          );
        }
      }
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.closing) {
      throw new AppError(
        'mcp.CLIENT_CLOSED',
        `MCP client for ${this.serverId} is closed`,
        undefined,
        502,
        { category: 'dependency_unavailable', retryable: false },
      );
    }
    if (this.exitError) throw this.exitError;
    if (this.child) {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        return this.child;
      }
      throw new AppError(
        'mcp.PROCESS_EXITED',
        `MCP server ${this.serverId} is no longer running`,
        undefined,
        502,
        { category: 'dependency_unavailable', retryable: false },
      );
    }

    const child = spawn(this.options.command, this.options.args ?? [], {
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.stdoutBuffer = '';
    // EPIPE on stdin is reported through the request callback and process
    // exit; keep the stream error from becoming an unhandled event.
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    child.on('error', (err) => {
      const error = new AppError(
        'mcp.SPAWN_FAILED',
        `could not start MCP server ${this.serverId}: ${err.message}`,
        undefined,
        502,
        { category: 'dependency_unavailable', retryable: false, cause: err },
      );
      this.exitError = error;
      this.rejectAll(error);
    });
    child.on('exit', (code, signal) => {
      this.child = undefined;
      if (this.exitError) {
        this.rejectAll(this.exitError);
        return;
      }
      if (this.closing) {
        this.rejectAll(
          new AppError(
            'mcp.CLIENT_CLOSED',
            `MCP client for ${this.serverId} is closed`,
            undefined,
            502,
            {
              category: 'dependency_unavailable',
              retryable: false,
            },
          ),
        );
        return;
      }
      const error = new AppError(
        'mcp.PROCESS_EXITED',
        `MCP server ${this.serverId} exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`,
        { code, signal, stderr: this.stderrLines.slice(-20).join('\n') },
        502,
        { category: 'dependency_unavailable', retryable: false },
      );
      this.exitError = error;
      this.rejectAll(error);
    });
    return child;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '').trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: {
      id?: number | string | null;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      // stdout is protocol-only; a non-JSON line is server noise. Keep it out
      // of the request path rather than failing an unrelated call.
      return;
    }
    if (message.id === undefined || message.id === null) return; // notification
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = Number.isFinite(id) ? this.pending.get(id) : undefined;
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(
        new AppError(
          'mcp.RPC_ERROR',
          `MCP error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown'}`,
          { code: message.error.code ?? null, method: pending.method },
          502,
          { category: 'dependency_unavailable', retryable: false },
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private onStderr(chunk: string): void {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      this.stderrLines.push(line);
      if (this.stderrLines.length > 20) this.stderrLines.shift();
      this.options.onStderr?.(line);
    }
  }

  private notify(method: string, params: Record<string, unknown> = {}): void {
    try {
      const child = this.ensureChild();
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // The initialized notification is best-effort; the next request surfaces
      // a dead process with the proper typed error.
    }
  }

  async initialize(): Promise<{ protocolVersion?: string; serverInfo?: unknown }> {
    const result = await this.request(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'triageai', version: '1.0.0' },
      },
      { operation: 'initialize' },
    );
    // MCP requires the initialized notification before normal traffic.
    this.notify('notifications/initialized');
    return result as { protocolVersion?: string; serverInfo?: unknown };
  }

  async listTools(): Promise<McpToolDescription[]> {
    const result = (await this.request('tools/list', {}, { operation: 'listTools' })) as {
      tools?: McpToolDescription[];
    };
    return result.tools ?? [];
  }

  async callTool(
    name: string,
    args: unknown,
    options: { access?: ToolAccess; generation?: boolean } = {},
  ): Promise<unknown> {
    return this.request(
      'tools/call',
      { name, arguments: args },
      {
        operation: 'callTool',
        tool: name,
        ...(options.access ? { access: options.access } : {}),
        ...(options.generation === undefined ? {} : { generation: options.generation }),
      },
    );
  }

  /** Imported tools are disabled until an admin fills the full contract. */
  importTools(serverId: string, tools: McpToolDescription[]): ImportedMcpTool[] {
    return importMcpTools(serverId, tools);
  }

  /** Stop the child process and fail anything still in flight. */
  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    this.rejectAll(
      new AppError(
        'mcp.CLIENT_CLOSED',
        `MCP client for ${this.serverId} is closed`,
        undefined,
        502,
        {
          category: 'dependency_unavailable',
          retryable: false,
        },
      ),
    );
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin.end();
    } catch {
      // The pipe may already be gone after a spawn failure.
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // Nothing left to kill.
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        finish();
      }, 500);
      timer.unref?.();
      child.once('exit', finish);
    });
  }

  private rejectAll(error: AppError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

/** Shared import mapping: disabled, high-risk, undo:none until completed. */
export function importMcpTools(serverId: string, tools: McpToolDescription[]): ImportedMcpTool[] {
  return tools.map((tool) => ({
    name: `mcp.${serverId}.${tool.name}`.slice(0, 64),
    remoteName: tool.name,
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
