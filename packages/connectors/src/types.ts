/**
 * Shared descriptor types for the generic connector library (Phase 15.T7).
 *
 * A connector importer produces tool descriptors; the host owns the policy
 * around them: egress, approvals, budgets and registration in `ToolRegistry`.
 * Nothing here imports the kernel, so connectors can be packaged and tested
 * without booting it.
 */
import type { ZodType } from 'zod';

export type ConnectorAccess = 'read' | 'write';
export type ConnectorRisk = 'low' | 'high';
export type ConnectorUndo = 'free' | 'compensable' | 'none';

/**
 * Injected HTTP call. The host passes the 18.5 `EgressClient.fetch` so the
 * connector never bypasses the allowlist, SSRF checks or denial audit.
 */
export type ConnectorFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ConnectorExecuteOptions {
  signal?: AbortSignal;
}

/**
 * The parts of a kernel `ToolDefinition` an importer can know before an admin
 * completes the contract. `inputSchema`/`outputSchema` are the Zod schemas the
 * host registers; `execute` is supplied by the concrete imported tool.
 */
export interface ConnectorToolDescriptor {
  name: string;
  version: string;
  owner: string;
  description: string;
  examples: unknown[];
  inputSchema: ZodType;
  outputSchema: ZodType;
  access: ConnectorAccess;
  risk: ConnectorRisk;
  undo: ConnectorUndo;
  /** Import-time default; writes start disabled until an admin enables them. */
  enabled: boolean;
  /** False when a generated permissive schema stands in for a missing schema. */
  complete: boolean;
  idempotent: boolean;
  scopes: string[];
  timeoutMs: number;
  /** Host egress allowlist entries derived from the connection endpoint. */
  allowedHosts?: string[];
}

export interface ConnectorErrorOptions {
  retryable?: boolean;
  /** Structured, non-secret context (codes, statuses, validation paths). */
  details?: unknown;
  cause?: unknown;
}

/** Typed connector failure; the host maps `code` onto its error envelope. */
export class ConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: string, message: string, options: ConnectorErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConnectorError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}
