import { describe, expect, it } from 'vitest';

import { createEventBus } from '../src/eventbus.js';
import { queueContractSuite } from '../src/queue/contract.js';
import { InlineQueue } from '../src/queue/inline.js';
import type { KernelLogger } from '../src/types.js';

const noopLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('eventBus', () => {
  it('delivers to matching subscribers and forbids bad names', async () => {
    const bus = createEventBus(noopLogger);
    const seen: string[] = [];
    bus.subscribe('demo.thing.updated', (p) => {
      seen.push(String((p as { x: string }).x));
    });
    bus.subscribe('other.thing.updated', () => {
      seen.push('wrong');
    });
    await bus.publish('demo.thing.updated', { x: 'yes' });
    await bus.publish('not-a-valid:name', {});
    expect(seen).toEqual(['yes']);
  });
});

// Both adapters must pass the same suite (contract-testing.md §3).
queueContractSuite('inline', async () => {
  const queue = new InlineQueue(noopLogger);
  return { queue, dispose: async () => queue.drain() };
});
