/**
 * Postgres-backed durable queue (default adapter, ADR-0003):
 * FOR UPDATE SKIP LOCKED claiming, lease + stuck-lease reaper, bounded
 * retries with backoff, dead-letter, idempotency keys, at-least-once.
 */
import { ulid } from 'ulid';

import type { Database, DeadLetterEntry, KernelLogger, QueueOptions } from '../types.js';

import type {
  EnqueueOptions,
  EnqueueResult,
  Queue,
  QueueSubscription,
  QueueWorker,
} from './types.js';
import { backoffFor } from './types.js';

const DEFAULT_LEASE_SECONDS = 60;

interface SubscriptionState {
  timer: ReturnType<typeof setInterval>;
  inflight: Promise<unknown>[];
  /** Poll cycles currently waiting on the DB / claiming work. */
  polls: Set<Promise<void>>;
  stopped: boolean;
}

export class PgQueue implements Queue {
  private subscriptions = new Map<string, SubscriptionState>();

  constructor(
    private database: Database,
    private logger: KernelLogger,
  ) {}

  async enqueue(queue: string, payload: unknown, opts?: EnqueueOptions): Promise<EnqueueResult> {
    const id = ulid();
    const maxAttempts = (opts?.retries ?? 3) + 1;
    const rows = await this.database.query<{ id: string }>(
      `INSERT INTO queue_jobs (id, queue, payload, idempotency_key, max_attempts)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [id, queue, JSON.stringify(payload ?? null), opts?.idempotencyKey ?? null, maxAttempts],
    );
    if (rows[0]) return { id: rows[0].id, deduped: false };
    const existing = await this.database.query<{ id: string }>(
      `SELECT id FROM queue_jobs WHERE queue = $1 AND idempotency_key = $2`,
      [queue, opts?.idempotencyKey ?? null],
    );
    return { id: existing[0]?.id ?? id, deduped: true };
  }

  subscribe(queue: string, handler: QueueWorker, opts?: QueueOptions): QueueSubscription {
    const concurrency = opts?.concurrency ?? 1;
    const pollIntervalMs = opts?.pollIntervalMs ?? 250;
    const state: SubscriptionState = {
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      inflight: [],
      polls: new Set(),
      stopped: false,
    };

    const poll = async (): Promise<void> => {
      if (state.stopped) return;
      try {
        // Stuck-lease reaper: crashed or too-slow workers release their claims.
        await this.database.query(
          `UPDATE queue_jobs SET status = 'pending' WHERE status = 'processing' AND lease_expires_at < now()`,
        );
        for (let i = 0; i < concurrency; i++) {
          if (state.stopped) break;
          const claimed = await this.claimOne(queue);
          if (!claimed) break;
          const work = this.runJob(claimed, handler, opts).finally(() => {
            const index = state.inflight.indexOf(work);
            if (index >= 0) state.inflight.splice(index, 1);
          });
          state.inflight.push(work);
        }
      } catch (err) {
        this.logger.error({ queue, err: (err as Error).message }, 'pg-queue poll failed');
      }
    };

    const runPoll = (): void => {
      if (state.stopped) return;
      const cycle = poll().finally(() => state.polls.delete(cycle));
      state.polls.add(cycle);
    };

    state.timer = setInterval(runPoll, pollIntervalMs);
    this.subscriptions.set(queue, state);
    runPoll();

    return {
      stop: async () => {
        state.stopped = true;
        clearInterval(state.timer);
        this.subscriptions.delete(queue);
        await PgQueue.settle(state);
      },
    };
  }

  private static async settle(state: SubscriptionState): Promise<void> {
    // Polls are the source of claims: wait for them first so every work item
    // they start is visible in `inflight` before we drain the queue.
    await Promise.allSettled([...state.polls]);
    await Promise.allSettled([...state.inflight]);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.subscriptions.values()].map((s) => PgQueue.settle(s)));
  }

  async close(): Promise<void> {
    const states = [...this.subscriptions.values()];
    for (const state of states) {
      state.stopped = true;
      clearInterval(state.timer);
    }
    // A poll can already be between `claimOne` and pushing its work item. Wait
    // for those cycles before closing the DB so no worker runs against a
    // closed connection (the old bug: a closed app stole the next test's job).
    await Promise.allSettled(states.map((state) => PgQueue.settle(state)));
    this.subscriptions.clear();
  }

  async deadLetter(queue?: string): Promise<DeadLetterEntry[]> {
    const rows = await this.database.query<{
      queue: string;
      payload: string;
      attempts: number;
      error: string | null;
      created_at: string;
    }>(
      `SELECT queue, payload::text AS payload, attempts, error, created_at
       FROM queue_deadletters ${queue ? 'WHERE queue = $1' : ''}
       ORDER BY created_at DESC LIMIT 100`,
      queue ? [queue] : undefined,
    );
    return rows.map((r) => ({
      queue: r.queue,
      payload: JSON.parse(r.payload) as unknown,
      attempts: r.attempts,
      error: r.error ?? '',
      createdAt: r.created_at,
    }));
  }

  private async claimOne(queue: string): Promise<{
    id: string;
    queue: string;
    payload: string;
    attempts: number;
    max_attempts: number;
  } | null> {
    const rows = await this.database.query<{
      id: string;
      queue: string;
      payload: string;
      attempts: number;
      max_attempts: number;
    }>(
      `WITH claimed AS (
         SELECT id FROM queue_jobs
         WHERE queue = $1 AND status = 'pending' AND ready_at <= now()
         ORDER BY ready_at, created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE queue_jobs SET status = 'processing',
         attempts = attempts + 1,
         lease_expires_at = now() + make_interval(secs => $2::int),
         updated_at = now()
       WHERE id IN (SELECT id FROM claimed)
       RETURNING id, queue, payload, attempts, max_attempts`,
      [queue, DEFAULT_LEASE_SECONDS],
    );
    return rows[0] ?? null;
  }

  private async runJob(
    job: { id: string; queue: string; payload: string; attempts: number; max_attempts: number },
    handler: QueueWorker,
    opts?: QueueOptions,
  ): Promise<void> {
    let payload: unknown = null;
    try {
      payload = JSON.parse(job.payload) as unknown;
    } catch {
      payload = job.payload;
    }
    try {
      await handler(payload, job.attempts);
      await this.database.query(
        `UPDATE queue_jobs SET status = 'done', updated_at = now() WHERE id = $1`,
        [job.id],
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn({ jobId: job.id, err: message }, 'queue job failed');
      if (job.attempts >= job.max_attempts) {
        await this.database.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO queue_deadletters (id, queue, payload, attempts, error)
             VALUES ($1, $2, $3, $4, $5)`,
            [ulid(), job.queue, job.payload, job.attempts, message],
          );
          await tx.query(`DELETE FROM queue_jobs WHERE id = $1`, [job.id]);
        });
        return;
      }
      const delayMs = backoffFor(job.attempts, opts?.backoffMs);
      await this.database.query(
        `UPDATE queue_jobs SET status = 'pending',
           ready_at = now() + make_interval(secs => $2::double precision / 1000.0),
           error = $3, updated_at = now()
         WHERE id = $1`,
        [job.id, delayMs, message],
      );
    }
  }
}
