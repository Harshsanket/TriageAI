/**
 * OutputChannel registry: the kernel routes deliveries by channel id without
 * knowing any provider vocabulary. Integration modules register their adapter
 * during `register()` (ADR-0018).
 *
 * A host-installed guard runs before every delivery so kill switches (18.5)
 * apply to every adapter at once, including adapters that bypass the shared
 * HTTP shell.
 */
import { AppError, invalid } from './errors.js';
import type {
  DeliveryContext,
  DeliveryResult,
  OutboundIntent,
  OutboundMatch,
  OutboundQuery,
  OutputChannel,
  OutputChannelRegistry,
} from './types.js';

export interface OutputChannelGuardContext {
  channel: string;
  ctx: DeliveryContext;
  intent: OutboundIntent;
}

/** Throw to deny a delivery; the host guard also writes the audit row. */
export type OutputChannelGuard = (context: OutputChannelGuardContext) => void | Promise<void>;

export interface GuardedOutputChannelRegistry extends OutputChannelRegistry {
  setGuard(guard: OutputChannelGuard | null): void;
}

class Registry implements GuardedOutputChannelRegistry {
  private readonly adapters = new Map<string, OutputChannel>();
  private guard?: OutputChannelGuard;

  register(channel: string, adapter: OutputChannel): void {
    if (!channel.trim()) throw invalid('output channel id must not be empty');
    if (this.adapters.has(channel)) {
      throw new AppError('kernel.CONFLICT', `output channel "${channel}" is already registered`);
    }
    this.adapters.set(channel, adapter);
  }

  has(channel: string): boolean {
    return this.adapters.has(channel);
  }

  channels(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /** Install (or clear) the host kill-switch guard. */
  setGuard(guard: OutputChannelGuard | null): void {
    this.guard = guard ?? undefined;
  }

  async deliver(ctx: DeliveryContext, intent: OutboundIntent): Promise<DeliveryResult> {
    await this.guard?.({ channel: intent.channel, ctx, intent });
    return this.get(intent.channel).deliver(ctx, intent);
  }

  async search(ctx: DeliveryContext, query: OutboundQuery): Promise<OutboundMatch[]> {
    const adapter = this.get(query.channel);
    if (!adapter.search) return [];
    return adapter.search(ctx, query);
  }

  private get(channel: string | undefined): OutputChannel {
    const adapter = channel ? this.adapters.get(channel) : undefined;
    if (!adapter) {
      throw new AppError(
        'INTEGRATION_DISABLED',
        `output channel "${channel ?? '(missing)'}" is not configured`,
        { configured: this.channels() },
        503,
        { category: 'internal', retryable: false, userMessage: 'This integration is not enabled.' },
      );
    }
    return adapter;
  }
}

export function createOutputChannelRegistry(): GuardedOutputChannelRegistry {
  return new Registry();
}

/**
 * Install a guard without widening `Capabilities.outputChannel` (modules keep
 * seeing the read-only registry interface). No-op for registries that predate
 * the seam, e.g. a test double.
 */
export function setOutputChannelGuard(
  registry: OutputChannelRegistry | undefined,
  guard: OutputChannelGuard | null,
): void {
  (registry as GuardedOutputChannelRegistry | undefined)?.setGuard(guard);
}
