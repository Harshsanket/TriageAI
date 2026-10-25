/**
 * OutputChannel registry: the kernel routes deliveries by channel id without
 * knowing any provider vocabulary. Integration modules register their adapter
 * during `register()` (ADR-0018).
 */
import { AppError } from './errors.js';
import type {
  DeliveryContext,
  DeliveryResult,
  OutboundIntent,
  OutboundMatch,
  OutboundQuery,
  OutputChannel,
  OutputChannelRegistry,
} from './types.js';

class Registry implements OutputChannelRegistry {
  private readonly adapters = new Map<string, OutputChannel>();

  register(channel: string, adapter: OutputChannel): void {
    if (!channel.trim()) throw new Error('output channel id must not be empty');
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

  async deliver(ctx: DeliveryContext, intent: OutboundIntent): Promise<DeliveryResult> {
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
      );
    }
    return adapter;
  }
}

export function createOutputChannelRegistry(): OutputChannelRegistry {
  return new Registry();
}
