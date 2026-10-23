/**
 * In-process event bus (ADR-0003: durability demands go through the queue;
 * subscriptions are best-effort, in-listener). Delivery is synchronous
 * publish → invoke; exceptions from subscribers are logged, not propagated
 * (publishers cannot rely on subscribers).
 */
import { z } from 'zod';

import type { KernelLogger } from './types.js';

export interface EventBus {
  publish(event: string, payload: unknown): void;
  subscribe(event: string, handler: (payload: unknown) => void): void;
}

interface Subscriber {
  event: string;
  handler: (payload: unknown) => void;
}

export function createEventBus(logger: KernelLogger): EventBus {
  const subscribers: Subscriber[] = [];

  return {
    publish(event, payload) {
      if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+/.test(event)) {
        // publish-side naming contract: module.entity.verb
        logger.error({ event }, 'event name must be module.entity.verb');
        return;
      }
      for (const sub of subscribers) {
        if (sub.event !== event) continue;
        try {
          sub.handler(payload);
        } catch (err) {
          logger.error({ event, err: (err as Error).message }, 'event subscriber failed');
        }
      }
    },
    subscribe(event, handler) {
      z.string().min(1).parse(event);
      subscribers.push({ event, handler });
    },
  };
}
