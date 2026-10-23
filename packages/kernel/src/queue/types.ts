/** Queue adapter contract — every adapter must pass the shared suite in contract.ts. */
import type { DeadLetterEntry, KernelLogger, QueueOptions } from '../types.js';

export type { DeadLetterEntry, QueueOptions };

export type QueueWorker = (payload: unknown, attempt: number) => Promise<void>;

export interface QueueSubscription {
  /** Stops claiming new jobs; in-flight handlers finish naturally. */
  stop(): Promise<void>;
}

export interface EnqueueOptions {
  idempotencyKey?: string;
  retries?: number;
}

export interface EnqueueResult {
  id: string;
  deduped: boolean;
}

export interface Queue {
  enqueue(queue: string, payload: unknown, opts?: EnqueueOptions): Promise<EnqueueResult>;
  subscribe(queue: string, handler: QueueWorker, opts?: QueueOptions): QueueSubscription;
  deadLetter(queue?: string): Promise<DeadLetterEntry[]>;
  /** Wait for in-flight handlers to settle (graceful shutdown). */
  drain(): Promise<void>;
}

/** Default retry backoff: first retry 100ms, then 1s steps. */
export function backoffFor(attempts: number, backoffMs?: number[]): number {
  const table = backoffMs ?? [100, 1000, 5000];
  const i = Math.max(0, attempts - 1);
  return table[Math.min(i, table.length - 1)] ?? table[table.length - 1] ?? 0;
}

export interface LoggerWire {
  logger: KernelLogger;
}
