/**
 * Slack incoming-webhook OutputChannel adapter. The webhook URL is a secret
 * (env only); retries/rate-limit handling come from the kernel HTTP shell.
 */
import { createHash } from 'node:crypto';

import {
  HttpOutputChannel,
  type DeliveryContext,
  type OutboundIntent,
  type OutputChannel,
} from '@triageai/kernel';

export interface SlackChannelOptions {
  webhookUrl: string;
  channel: string;
  fetchImpl?: typeof fetch;
}

export function createSlackChannel(options: SlackChannelOptions): OutputChannel {
  const refFor = (text: string): string =>
    `slack:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
  return new HttpOutputChannel({
    channel: options.channel,
    enabled: () => options.webhookUrl.length > 0,
    fetchImpl: options.fetchImpl,
    request: (_ctx: DeliveryContext, intent: OutboundIntent) => ({
      url: options.webhookUrl,
      method: 'POST',
      body: { text: intent.body },
    }),
    parse: (_response, _ctx, intent) => ({
      ref: refFor(intent.body),
      detail: { length: intent.body.length },
    }),
  });
}
