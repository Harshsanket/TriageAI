/**
 * TypeScript module SDK (ADR-0055 §7). Validates each envelope before sending
 * and again on receipt, enforces deadlines and the replay cache, and never
 * lets a caller turn validation off.
 */
import {
  parseMp1Envelope,
  type Mp1DataClass,
  type Mp1Envelope,
  type Mp1Op,
} from '@triageai/contracts';

export interface Mp1Transport {
  send(envelope: Mp1Envelope, identity: string): Promise<unknown>;
}

export interface ModuleClientOptions {
  moduleId: string;
  version: string;
  transport: Mp1Transport;
  /** Default data class for requests; effectful calls should override it. */
  dataClass?: Mp1DataClass;
  /** Default request deadline (max 10 minutes). */
  deadlineMs?: number;
  now?: () => number;
  /** Injectable id generator (defaults to crypto.randomUUID). */
  newId?: () => string;
}

const seen = new WeakMap<ModuleClient, Map<string, number>>();

export class ModuleClient {
  private readonly seenIds: Map<string, number>;

  constructor(private readonly options: ModuleClientOptions) {
    this.seenIds = new Map();
    seen.set(this, this.seenIds);
  }

  private id(): string {
    return this.options.newId?.() ?? crypto.randomUUID();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  async call<T = unknown>(
    op: Mp1Op,
    schema: string,
    payload: unknown,
    opts: {
      dataClass?: Mp1DataClass;
      idempotencyKey?: string;
      runId?: string;
      deadlineMs?: number;
    } = {},
  ): Promise<T> {
    const now = this.now();
    const deadlineMs = Math.min(opts.deadlineMs ?? this.options.deadlineMs ?? 30_000, 10 * 60_000);
    const request: Mp1Envelope = {
      mp: '1.0',
      id: this.id(),
      kind: 'request',
      op,
      from: `module:${this.options.moduleId}@${this.options.version}`,
      to: 'core',
      schema,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      deadline: new Date(now + deadlineMs).toISOString(),
      dataClass: opts.dataClass ?? this.options.dataClass ?? 'internal',
      payload,
    };
    const outbound = parseMp1Envelope(request);
    if (!outbound.ok)
      throw new Error(`refusing to send an invalid MP1 envelope: ${outbound.issues[0]?.message}`);

    const raw = await this.options.transport.send(outbound.envelope, outbound.envelope.from);
    const inbound = parseMp1Envelope(raw);
    if (!inbound.ok)
      throw new Error(`received an invalid MP1 envelope: ${inbound.issues[0]?.message}`);
    const response = inbound.envelope;
    if (response.kind !== 'response') throw new Error('MP1 response kind must be "response"');
    if (response.correlationId !== request.id)
      throw new Error('MP1 response correlationId mismatch');
    const deadline = Date.parse(response.deadline);
    if (deadline < this.now()) throw new Error('MP1 response arrived after its deadline');
    if (this.seenIds.has(response.id)) throw new Error('MP1 response id was already seen');
    this.seenIds.set(response.id, deadline);
    for (const [id, expires] of this.seenIds) {
      if (expires < this.now()) this.seenIds.delete(id);
    }
    if (response.error) {
      const error = new Error(response.error.userMessage) as Error & { envelope: unknown };
      error.envelope = response.error;
      throw error;
    }
    return response.payload as T;
  }
}

export function createModuleClient(options: ModuleClientOptions): ModuleClient {
  return new ModuleClient(options);
}
