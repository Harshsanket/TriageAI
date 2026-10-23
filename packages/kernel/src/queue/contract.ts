/**
 * The Queue capability contract suite (contracts/contract-testing.md §3).
 * Run against EVERY adapter (pg-queue, inline, bullmq later); adapters that
 * fail it are not drop-in compatible with modules using the queue.
 */
import { expect, it } from 'vitest';

import type { Queue, QueueOptions, QueueSubscription } from './types.js';

export interface QueueFactory {
  (): Promise<{ queue: Queue; dispose(): Promise<void> }>;
}

const tick = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

export function queueContractSuite(
  name: string,
  factory: QueueFactory,
  describeOptions: (
    base: Required<Pick<QueueOptions, 'pollIntervalMs'>> & { backoffMs: number[] },
  ) => QueueOptions = (base) => base,
): void {
  it(`${name}: delivers an enqueued job (happy path)`, async () => {
    const { queue, dispose } = await factory();
    const subs: QueueSubscription[] = [];
    try {
      const payloads: unknown[] = [];
      subs.push(
        queue.subscribe(
          't.happy',
          async (payload) => {
            payloads.push(payload);
          },
          describeOptions({ pollIntervalMs: 50, backoffMs: [50, 100, 200] }),
        ),
      );
      await queue.enqueue('t.happy', { n: 1 });
      await tick(400);
      expect(payloads).toEqual([{ n: 1 }]);
    } finally {
      await Promise.all(subs.map((s) => s.stop()));
      await dispose();
    }
  });

  it(`${name}: retries a failing handler with backoff, then completes`, async () => {
    const { queue, dispose } = await factory();
    const subs: QueueSubscription[] = [];
    try {
      const attemptsSeen: number[] = [];
      const ok: unknown[] = [];
      subs.push(
        queue.subscribe(
          't.retry',
          async (payload, attempt) => {
            attemptsSeen.push(attempt);
            if (attempt < 1) throw new Error('flaky first attempt');
            ok.push(payload);
          },
          describeOptions({ pollIntervalMs: 50, backoffMs: [50, 100, 200] }),
        ),
      );
      await queue.enqueue('t.retry', { n: 2 });
      await tick(700);
      expect(attemptsSeen.length).toBeGreaterThanOrEqual(1);
      expect(ok).toEqual([{ n: 2 }]);
    } finally {
      await Promise.all(subs.map((s) => s.stop()));
      await dispose();
    }
  });

  it(`${name}: order is preserved per queue (FIFO)`, async () => {
    const { queue, dispose } = await factory();
    const subs: QueueSubscription[] = [];
    try {
      const order: number[] = [];
      subs.push(
        queue.subscribe(
          't.fifo',
          async (payload) => {
            order.push((payload as { n: number }).n);
            await tick(5);
          },
          describeOptions({ pollIntervalMs: 50, backoffMs: [50, 100, 200] }),
        ),
      );
      await queue.enqueue('t.fifo', { n: 1 });
      await queue.enqueue('t.fifo', { n: 2 });
      await queue.enqueue('t.fifo', { n: 3 });
      await tick(500);
      expect(order).toEqual([1, 2, 3]);
    } finally {
      await Promise.all(subs.map((s) => s.stop()));
      await dispose();
    }
  });

  it(`${name}: deduplicates on idempotency key`, async () => {
    const { queue, dispose } = await factory();
    const subs: QueueSubscription[] = [];
    try {
      const seen: unknown[] = [];
      subs.push(
        queue.subscribe(
          't.idem',
          async (payload) => {
            seen.push(payload);
          },
          describeOptions({ pollIntervalMs: 50, backoffMs: [50, 100, 200] }),
        ),
      );
      const first = await queue.enqueue('t.idem', { n: 3 }, { idempotencyKey: 'k1' });
      const second = await queue.enqueue('t.idem', { n: 3 }, { idempotencyKey: 'k1' });
      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(true);
      await tick(400);
      expect(seen).toEqual([{ n: 3 }]);
    } finally {
      await Promise.all(subs.map((s) => s.stop()));
      await dispose();
    }
  });

  it(`${name}: poison job lands in the dead-letter list after retries`, async () => {
    const { queue, dispose } = await factory();
    const subs: QueueSubscription[] = [];
    try {
      subs.push(
        queue.subscribe(
          't.dlq',
          async () => {
            throw new Error('always broken');
          },
          describeOptions({ pollIntervalMs: 50, backoffMs: [50, 100, 200] }),
        ),
      );
      await queue.enqueue('t.dlq', { n: 4 }, { retries: 1 });
      await tick(700);
      const dlq = await queue.deadLetter('t.dlq');
      expect(dlq.length).toBe(1);
      expect(dlq[0].error).toContain('always broken');
      expect(dlq[0].attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await Promise.all(subs.map((s) => s.stop()));
      await dispose();
    }
  });
}
