/**
 * Inline queue adapter: synchronous in-process execution for tests and
 * rule-only configs. NOT durable — production profiles use pg-queue (ADR-0003).
 */
import { ulid } from 'ulid';

import type { DeadLetterEntry, KernelLogger } from '../types.js';

import type {
  EnqueueOptions,
  EnqueueResult,
  Queue,
  QueueOptions,
  QueueSubscription,
  QueueWorker,
} from './types.js';
import { backoffFor } from './types.js';

interface Job {
  id: string;
  queue: string;
  payload: unknown;
  idempotencyKey?: string;
  attempts: number;
  maxAttempts: number;
}

const PENDING_RETRY_DELAY_MS = 50; // no handler registered yet → reschedule briefly

export class InlineQueue implements Queue {
  private jobs = new Map<string, Job>();
  private handlers = new Map<string, QueueWorker>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private dead: DeadLetterEntry[] = [];
  private defaultRetries: number;

  constructor(_logger: KernelLogger, opts: Partial<{ retries: number }> = {}) {
    void _logger;
    this.defaultRetries = opts.retries ?? 3;
  }

  async enqueue(queue: string, payload: unknown, opts?: EnqueueOptions): Promise<EnqueueResult> {
    if (opts?.idempotencyKey) {
      for (const job of this.jobs.values()) {
        if (job.queue === queue && job.idempotencyKey === opts.idempotencyKey) {
          return { id: job.id, deduped: true };
        }
      }
    }
    const job: Job = {
      id: ulid(),
      queue,
      payload,
      idempotencyKey: opts?.idempotencyKey,
      attempts: 0,
      maxAttempts: (opts?.retries ?? this.defaultRetries) + 1,
    };
    this.jobs.set(job.id, job);
    this.dispatch(job, 0);
    return { id: job.id, deduped: false };
  }

  subscribe(queue: string, handler: QueueWorker, opts?: QueueOptions): QueueSubscription {
    this.handlers.set(queue, handler);
    void opts;
    for (const job of this.jobs.values()) {
      if (job.queue === queue && !this.timers.has(job.id)) this.dispatch(job, 0);
    }
    return {
      stop: async () => {
        this.handlers.delete(queue);
      },
    };
  }

  async deadLetter(queue?: string): Promise<DeadLetterEntry[]> {
    return queue ? this.dead.filter((d) => d.queue === queue) : [...this.dead];
  }

  async drain(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await this.drain();
  }

  private dispatch(job: Job, delayMs: number): void {
    const existing = this.timers.get(job.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      const handler = this.handlers.get(job.queue);
      if (!handler) {
        // A worker will subscribe later; hold the job pending until then.
        this.dispatch(job, PENDING_RETRY_DELAY_MS);
        return;
      }
      void (async () => {
        try {
          await handler(job.payload, job.attempts);
          this.jobs.delete(job.id);
        } catch (err) {
          job.attempts += 1;
          if (job.attempts >= job.maxAttempts) {
            this.dead.push({
              queue: job.queue,
              payload: job.payload,
              attempts: job.attempts,
              error: (err as Error).message,
              createdAt: new Date().toISOString(),
            });
            this.jobs.delete(job.id);
            return;
          }
          this.dispatch(job, backoffFor(job.attempts, [50, 200, 1000]));
        }
      })();
    }, delayMs);
    this.timers.set(job.id, timer);
  }
}
