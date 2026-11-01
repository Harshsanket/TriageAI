/**
 * MP1 broker (ADR-0055 §1–§4): the single place that validates identity,
 * grants and schemas, dispatches an op and writes message metadata to audit.
 */
import { createHash } from 'node:crypto';

import {
  parseMp1Envelope,
  type ErrorEnvelope,
  type Mp1Envelope,
  type Mp1Op,
} from '@triageai/contracts';
import { ulid } from 'ulid';

import { AppError, invalid, internal, policyBlocked } from '../errors.js';
import { diffPermissions, type GrantsEngine } from '../grants.js';
import type { WorkItemStore } from '../state/index.js';
import { Mp1Signer } from './signer.js';
import { ReplayCache } from './replay.js';

export interface Mp1AuditEntry {
  id: string;
  from: string;
  to: string;
  op: string;
  schema: string;
  payloadSha256: string;
  outcome: 'ok' | 'error' | 'denied' | 'invalid';
  latencyMs: number;
}

export interface Mp1HandlerContext {
  envelope: Mp1Envelope;
  principal: Mp1Envelope['from'];
  moduleId: string | null;
  moduleVersion: string | null;
  grants: GrantsEngine | null;
}

export type Mp1Handler = (payload: unknown, context: Mp1HandlerContext) => Promise<unknown>;

export interface Mp1BrokerOptions {
  handlers: Partial<Record<Mp1Op, Mp1Handler>>;
  grantsFor: (moduleId: string, version: string) => GrantsEngine | null;
  audit?: (entry: Mp1AuditEntry) => void | Promise<void>;
  signer?: Mp1Signer;
  replay?: ReplayCache;
  now?: () => number;
  defaultDeadlineMs?: number;
  maxDeadlineMs?: number;
  maxBytes?: number;
  workItems?: WorkItemStore;
  /** Agent principals get a subset of their module's grants (ADR-0055 §4). */
  agentGrantsFor?: (agentId: string, moduleId: string) => GrantsEngine | null;
}

const MODULE_PRINCIPAL = /^module:([a-z0-9-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const AGENT_PRINCIPAL = /^agent:[a-z0-9-]+(?:@\d+\.\d+\.\d+)?\/module:([a-z0-9-]+)$/;

function principalModule(
  principal: string,
): { moduleId: string; version: string | null; agentId: string | null } | null {
  const module = MODULE_PRINCIPAL.exec(principal);
  if (module?.[1]) return { moduleId: module[1], version: module[2] ?? null, agentId: null };
  const agent = AGENT_PRINCIPAL.exec(principal);
  if (agent?.[1])
    return { moduleId: agent[1], version: null, agentId: principal.split('/')[0] ?? null };
  return null;
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}

export class Mp1Broker {
  private readonly now: () => number;
  private readonly replay: ReplayCache;
  readonly signer: Mp1Signer;

  constructor(private readonly options: Mp1BrokerOptions) {
    this.now = options.now ?? Date.now;
    this.replay = options.replay ?? new ReplayCache();
    this.signer = options.signer ?? Mp1Signer.generate();
  }

  private async audit(entry: Mp1AuditEntry): Promise<void> {
    try {
      await this.options.audit?.(entry);
    } catch {
      // Audit failures must never turn a valid message into a failure.
    }
  }

  private authorize(envelope: Mp1Envelope, context: Mp1HandlerContext): void {
    if (envelope.from === 'core') return;
    const principal = principalModule(envelope.from);
    if (!principal) {
      throw policyBlocked(`principal ${envelope.from} may not call the core directly`);
    }
    const grants = context.grants;
    if (!grants) throw policyBlocked(`principal ${envelope.from} has no approved grants`);
    if (
      envelope.to !== 'core' &&
      !envelope.to.startsWith('capability:') &&
      !envelope.to.startsWith('event:')
    ) {
      throw policyBlocked(`op ${envelope.op} is not addressed to the core`);
    }
    const payload = envelope.payload as Record<string, unknown>;
    switch (envelope.op) {
      case 'event.publish':
        grants.assertEventPublish(String(payload.event ?? ''));
        break;
      case 'event.deliver':
        grants.assertEventSubscribe(String(payload.event ?? ''));
        break;
      case 'capability.call':
        grants.assertCapabilityConsume(String(payload.capability ?? ''));
        break;
      case 'knowledge.query':
        grants.assertKnowledge(
          String(payload.collection ?? ''),
          payload.mode === 'write' ? 'write' : 'read',
        );
        break;
      case 'task.create':
      case 'task.update':
      case 'task.get':
        break; // task ops are scoped to the principal's module/agent below
      default:
        break;
    }
  }

  private buildResponse(
    request: Mp1Envelope,
    payload: unknown,
    error?: ErrorEnvelope,
  ): Mp1Envelope {
    const response: Mp1Envelope = {
      mp: '1.0',
      id: ulid(),
      kind: 'response',
      op: request.op,
      from: 'core',
      to: request.from,
      schema: 'mp1.response@1',
      correlationId: request.id,
      deadline: new Date(this.now() + (this.options.defaultDeadlineMs ?? 30_000)).toISOString(),
      dataClass: request.dataClass,
      payload: error ? null : payload,
      ...(error ? { error } : {}),
    };
    response.coreSig = this.signer.sign(response);
    return response;
  }

  /**
   * Validate, authorize and dispatch one envelope. Returns a signed response
   * envelope; never throws for broker-level refusals (they become error
   * responses). Transport failures throw.
   */
  async dispatch(raw: unknown, authenticatedPrincipal?: string): Promise<Mp1Envelope> {
    const started = this.now();
    const serialized = JSON.stringify(raw);
    if (Buffer.byteLength(serialized, 'utf8') > (this.options.maxBytes ?? 1024 * 1024)) {
      throw invalid('MP1 envelope exceeds 1 MiB');
    }
    const parsed = parseMp1Envelope(raw);
    if (!parsed.ok) {
      await this.audit({
        id: 'invalid',
        from: 'unknown',
        to: 'core',
        op: 'invalid',
        schema: 'unknown',
        payloadSha256: sha256(raw),
        outcome: 'invalid',
        latencyMs: this.now() - started,
      });
      throw invalid('invalid MP1 envelope', parsed.issues);
    }
    const envelope = parsed.envelope;
    const now = this.now();
    const deadline = Date.parse(envelope.deadline);
    if (!Number.isFinite(deadline) || deadline < now) {
      await this.audit({
        id: envelope.id,
        from: envelope.from,
        to: envelope.to,
        op: envelope.op,
        schema: envelope.schema,
        payloadSha256: sha256(envelope.payload),
        outcome: 'invalid',
        latencyMs: this.now() - started,
      });
      return this.buildResponse(
        envelope,
        null,
        new AppError('MP1_DEADLINE_EXPIRED', 'the message deadline has passed', undefined, 408, {
          category: 'timeout',
          retryable: false,
        }).toEnvelope(envelope.id),
      );
    }
    if (deadline > now + (this.options.maxDeadlineMs ?? 10 * 60_000)) {
      return this.buildResponse(
        envelope,
        null,
        invalid('MP1 deadline exceeds the 10 minute maximum').toEnvelope(envelope.id),
      );
    }
    if (envelope.kind !== 'response' && !this.replay.check(envelope, now)) {
      await this.audit({
        id: envelope.id,
        from: envelope.from,
        to: envelope.to,
        op: envelope.op,
        schema: envelope.schema,
        payloadSha256: sha256(envelope.payload),
        outcome: 'denied',
        latencyMs: this.now() - started,
      });
      return this.buildResponse(
        envelope,
        null,
        new AppError('MP1_REPLAY', 'the message id was already seen', undefined, 409, {
          category: 'conflict',
          retryable: false,
        }).toEnvelope(envelope.id),
      );
    }

    // The core stamps `from` from transport identity; a sender's own claim is
    // ignored (ADR-0055 §2/§4).
    const from = authenticatedPrincipal
      ? (authenticatedPrincipal as Mp1Envelope['from'])
      : envelope.from;
    const stamped: Mp1Envelope = { ...envelope, from };
    const principal = principalModule(from);
    const moduleGrants =
      principal && principal.version
        ? this.options.grantsFor(principal.moduleId, principal.version)
        : null;
    let grants = moduleGrants;
    if (principal?.agentId && this.options.agentGrantsFor) {
      const agentGrants = this.options.agentGrantsFor(
        principal.agentId.replace(/^agent:/, '').split('@')[0] ?? '',
        principal.moduleId,
      );
      if (!agentGrants) throw policyBlocked('agent principal has no grants');
      if (moduleGrants) {
        const widening = diffPermissions(
          principal.moduleId,
          null,
          '',
          moduleGrants.permissions,
          agentGrants.permissions,
        );
        if (widening.added.length > 0) {
          throw policyBlocked(
            `agent grants exceed module ${principal.moduleId}: ${widening.added.join(', ')}`,
          );
        }
      }
      grants = agentGrants;
    }
    const context: Mp1HandlerContext = {
      envelope: stamped,
      principal: stamped.from,
      moduleId: principal?.moduleId ?? null,
      moduleVersion: principal?.version ?? null,
      grants,
    };

    try {
      this.authorize(stamped, context);
      const handler =
        this.options.handlers[envelope.op] ??
        (envelope.op === 'task.create' ||
        envelope.op === 'task.update' ||
        envelope.op === 'task.get'
          ? this.taskHandler(envelope.op)
          : undefined);
      if (!handler) throw invalid(`unsupported MP1 op ${envelope.op}`);
      const result = await handler(stamped.payload, context);
      await this.audit({
        id: stamped.id,
        from: stamped.from,
        to: stamped.to,
        op: stamped.op,
        schema: stamped.schema,
        payloadSha256: sha256(stamped.payload),
        outcome: 'ok',
        latencyMs: this.now() - started,
      });
      return this.buildResponse(stamped, result);
    } catch (err) {
      const error =
        err instanceof AppError
          ? err.toEnvelope(stamped.id)
          : internal((err as Error).message).toEnvelope(stamped.id);
      await this.audit({
        id: stamped.id,
        from: stamped.from,
        to: stamped.to,
        op: stamped.op,
        schema: stamped.schema,
        payloadSha256: sha256(stamped.payload),
        outcome: error.code === 'POLICY_BLOCKED' ? 'denied' : 'error',
        latencyMs: this.now() - started,
      });
      return this.buildResponse(stamped, null, error);
    }
  }

  /** Work-item task handlers (`task.*`) shared by agent and external principals. */
  private taskHandler(op: 'task.create' | 'task.update' | 'task.get'): Mp1Handler {
    return async (payload, context) => {
      const store = this.options.workItems;
      if (!store) throw invalid('task ops require a work-item store');
      const input = payload as Record<string, unknown>;
      if (op === 'task.create') {
        return store.create({
          workspaceId: String(input.workspaceId),
          rootRunId: String(input.rootRunId ?? context.envelope.runId ?? input.taskId),
          title: String(input.title),
          doneWhen: String(input.doneWhen),
          inputRefs: (input.inputRefs as string[] | undefined) ?? [],
        });
      }
      const id = String(input.taskId);
      if (op === 'task.get') {
        const item = await store.get(id);
        if (!item) throw invalid(`task ${id} not found`);
        return item;
      }
      return store.claim(id, String(input.agentId ?? context.principal));
    };
  }

  /** Convenience for in-process callers: throw on an error response. */
  async invoke<T = unknown>(raw: unknown, authenticatedPrincipal?: string): Promise<T> {
    const response = await this.dispatch(raw, authenticatedPrincipal);
    if (response.error) {
      throw new AppError(
        response.error.code,
        response.error.detail ?? response.error.userMessage,
        { envelope: response.error },
        response.error.status,
        {
          category: response.error.category,
          retryable: response.error.retryable,
          retryAfterMs: response.error.retryAfterMs,
          userMessage: response.error.userMessage,
        },
      );
    }
    return response.payload as T;
  }
}

/** Build a module-originated request envelope. */
export function mp1Request(input: {
  id?: string;
  op: Mp1Op;
  from: Mp1Envelope['from'];
  to: Mp1Envelope['to'];
  schema: string;
  payload: unknown;
  dataClass?: Mp1Envelope['dataClass'];
  runId?: string;
  idempotencyKey?: string;
  deadlineMs?: number;
  now?: number;
}): Mp1Envelope {
  const now = input.now ?? Date.now();
  return {
    mp: '1.0',
    id: input.id ?? ulid(),
    kind: 'request',
    op: input.op,
    from: input.from,
    to: input.to,
    schema: input.schema,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    deadline: new Date(now + (input.deadlineMs ?? 30_000)).toISOString(),
    dataClass: input.dataClass ?? 'internal',
    payload: input.payload,
  };
}
