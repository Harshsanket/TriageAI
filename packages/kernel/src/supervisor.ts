/**
 * Module supervisor (ADR-0054 §6, ADR-0055 §4): handshake, Stage-A session
 * tokens, health, drain/stop, timeouts and the circuit breaker. The core's
 * worker still leases queue jobs; containers only receive `stage.invoke`.
 */
import {
  parseMp1Envelope,
  type Mp1Envelope,
  type Mp1StageInvokePayload,
} from '@triageai/contracts';
import { ulid } from 'ulid';

import { AppError, dependencyUnavailable, invalid, timeout } from './errors.js';
import { Mp1Signer } from './mp1/signer.js';
import { Mp1SessionIssuer } from './mp1/sessionToken.js';
import type { ModuleRunMode, TriageModule } from './types.js';
import { CircuitBreaker, type CircuitBreakerOptions } from './circuitBreaker.js';
import {
  assertThirdPartyContainerAllowed,
  DEFAULT_MTLS_POLICY,
  type MtlsPolicy,
} from './mp1/mtls.js';

export interface Mp1TransportClient {
  send(envelope: Mp1Envelope, sessionToken: string): Promise<unknown>;
}

export interface SupervisedModule {
  id: string;
  version: string;
  principal: string;
  runMode: ModuleRunMode;
  endpoint?: string;
  session: { token: string; expiresAt: number; jti: string };
}

export interface ModuleSupervisorOptions {
  generation?: string;
  transport: (entry: SupervisedModule) => Mp1TransportClient;
  signer?: Mp1Signer;
  breaker?: CircuitBreakerOptions;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  onEvent?: (event: Record<string, unknown>) => void;
  mtls?: MtlsPolicy;
}

const RUN_MODES = new Set<ModuleRunMode>(['in-process', 'worker', 'container']);

export class ModuleSupervisor {
  readonly issuer: Mp1SessionIssuer;
  private readonly now: () => number;
  private readonly breaker: CircuitBreaker;
  private readonly entries = new Map<string, SupervisedModule>();

  constructor(private readonly options: ModuleSupervisorOptions) {
    const generation = options.generation ?? `gen-${Date.now()}`;
    this.issuer = new Mp1SessionIssuer(generation);
    this.now = options.now ?? Date.now;
    this.breaker = new CircuitBreaker({ threshold: 5, cooldownMs: 30_000, ...options.breaker });
  }

  list(): SupervisedModule[] {
    return [...this.entries.values()];
  }

  get(id: string): SupervisedModule | undefined {
    return this.entries.get(id);
  }

  private envelope(
    module: Pick<SupervisedModule, 'id' | 'version' | 'principal'>,
    op: Mp1Envelope['op'],
    schema: string,
    payload: unknown,
    idempotencyKey?: string,
  ): Mp1Envelope {
    return {
      mp: '1.0',
      id: ulid(),
      kind: 'request',
      op,
      from: 'core',
      to: `module:${module.id}@${module.version}`,
      schema,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      deadline: new Date(this.now() + (this.options.requestTimeoutMs ?? 30_000)).toISOString(),
      dataClass: 'internal',
      payload,
    };
  }

  private async send(
    entry: SupervisedModule,
    envelope: Mp1Envelope,
    timeoutMs: number,
  ): Promise<Mp1Envelope> {
    if (this.breaker.isOpen(entry.id)) {
      throw dependencyUnavailable(
        new AppError('MODULE_UNAVAILABLE', `module ${entry.id} is unavailable`, undefined, 503),
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.options.transport(entry).send(envelope, entry.session.token),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeout(`module ${entry.id} timed out`)), timeoutMs);
        }),
      ]);
      const parsed = parseMp1Envelope(raw);
      if (!parsed.ok) throw invalid(`module ${entry.id} returned an invalid MP1 envelope`);
      const response = parsed.envelope;
      if (response.correlationId !== envelope.id) {
        throw invalid(`module ${entry.id} answered a different request`);
      }
      if (response.error) {
        throw new AppError(
          response.error.code,
          response.error.detail ?? response.error.userMessage,
          undefined,
          response.error.status,
          {
            category: response.error.category,
            retryable: response.error.retryable,
            retryAfterMs: response.error.retryAfterMs,
            userMessage: response.error.userMessage,
          },
        );
      }
      this.breaker.recordSuccess(entry.id);
      return response;
    } catch (err) {
      if (err instanceof AppError && err.code === 'MODULE_UNAVAILABLE') throw err;
      this.breaker.recordFailure(entry.id);
      throw dependencyUnavailable(err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async enroll(
    module: TriageModule,
    opts: { packageVerified: boolean; runMode?: ModuleRunMode; endpoint?: string },
  ): Promise<SupervisedModule> {
    const runMode = opts.runMode ?? module.runMode ?? 'in-process';
    if (!RUN_MODES.has(runMode)) throw invalid(`unknown module run mode ${runMode}`);
    if (runMode !== 'in-process' && !opts.packageVerified) {
      throw new AppError(
        'MODULE_SIGNATURE_INVALID',
        `module ${module.id} must have a valid signed package before it can leave the process`,
        undefined,
        403,
        { category: 'policy_blocked', retryable: false },
      );
    }
    assertThirdPartyContainerAllowed(
      { moduleId: module.id, thirdParty: module.thirdParty === true, runMode },
      this.options.mtls ?? DEFAULT_MTLS_POLICY,
    );
    const principal = `module:${module.id}@${module.version}`;
    const session = this.issuer.issue(principal, 15 * 60_000);
    const entry: SupervisedModule = {
      id: module.id,
      version: module.version,
      principal,
      runMode,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      session: {
        token: session.token,
        expiresAt: session.claims.exp * 1000,
        jti: session.claims.jti,
      },
    };
    if (runMode === 'in-process') {
      this.entries.set(module.id, entry);
      return entry;
    }

    const handshake = this.envelope(entry, 'handshake', 'mp1.handshake@1', {
      mp: '1.0',
      moduleId: module.id,
      version: module.version,
      schemas: ['mp1.handshake@1', 'mp1.stage.invoke@1', 'mp1.response@1'],
      runMode,
    });
    await this.send(entry, handshake, this.options.handshakeTimeoutMs ?? 10_000);
    this.entries.set(module.id, entry);
    this.options.onEvent?.({ action: 'module.enrolled', moduleId: module.id, runMode });
    return entry;
  }

  /** Session renewal; containers call this before `expiresAt`. */
  renew(id: string): SupervisedModule {
    const entry = this.entries.get(id);
    if (!entry) throw invalid(`module ${id} is not enrolled`);
    const session = this.issuer.issue(entry.principal, 15 * 60_000);
    entry.session = {
      token: session.token,
      expiresAt: session.claims.exp * 1000,
      jti: session.claims.jti,
    };
    return entry;
  }

  async health(id: string): Promise<'healthy' | 'degraded' | 'down'> {
    const entry = this.entries.get(id);
    if (!entry) return 'down';
    try {
      const response = await this.send(
        entry,
        this.envelope(entry, 'health', 'mp1.health@1', {}),
        5_000,
      );
      const payload = response.payload as { status?: string } | null;
      if (payload?.status === 'degraded') return 'degraded';
      return 'healthy';
    } catch {
      return 'down';
    }
  }

  async invokeStage(
    id: string,
    payload: Mp1StageInvokePayload,
    opts: { timeoutMs?: number; idempotencyKey: string },
  ): Promise<unknown> {
    const entry = this.entries.get(id);
    if (!entry) throw dependencyUnavailable(`module ${id} is not enrolled`);
    if (entry.runMode === 'in-process')
      throw invalid('in-process modules do not use the supervisor');
    const response = await this.send(
      entry,
      this.envelope(entry, 'stage.invoke', 'mp1.stage.invoke@1', payload, opts.idempotencyKey),
      opts.timeoutMs ?? this.options.requestTimeoutMs ?? 30_000,
    );
    return response.payload;
  }

  async drain(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.runMode === 'in-process') return;
    await this.send(entry, this.envelope(entry, 'drain', 'mp1.drain@1', {}), 10_000);
  }

  async stop(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      if (entry.runMode !== 'in-process') {
        await this.send(entry, this.envelope(entry, 'stop', 'mp1.stop@1', {}), 5_000);
      }
    } finally {
      this.entries.delete(id);
    }
  }
}
