/**
 * Transactional outbox (Phase 18.3, ADR-0050 prerequisite).
 *
 * `publish` writes the event row before any in-process delivery and enqueues a
 * durable retry. Subscribers stay idempotent because the retry can re-deliver
 * after a crash. The in-process bus remains best-effort for subscriber errors.
 */
import { ulid } from 'ulid';

import type { EventBus } from './eventbus.js';
import type { Queue } from './queue/types.js';
import type { Database, KernelLogger } from './types.js';

export interface OutboxRow {
  id: string;
  topic: string;
  payload: unknown;
  attempts: number;
  publishedAt: string | null;
}

export class OutboxStore {
  constructor(private readonly database: Database) {}

  async enqueue(topic: string, payload: unknown): Promise<string> {
    const id = ulid();
    await this.database.query(
      `INSERT INTO outbox_events (id, topic, payload) VALUES ($1, $2, $3)`,
      [id, topic, payload],
    );
    return id;
  }

  async get(id: string): Promise<OutboxRow | null> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM outbox_events WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row
      ? {
          id: row.id as string,
          topic: row.topic as string,
          payload: row.payload,
          attempts: Number(row.attempts),
          publishedAt: row.published_at ? new Date(row.published_at as string).toISOString() : null,
        }
      : null;
  }

  async pending(limit = 50): Promise<OutboxRow[]> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM outbox_events
       WHERE published_at IS NULL AND available_at <= now()
       ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id as string,
      topic: row.topic as string,
      payload: row.payload,
      attempts: Number(row.attempts),
      publishedAt: null,
    }));
  }

  async markPublished(id: string): Promise<void> {
    await this.database.query(
      `UPDATE outbox_events SET published_at = now() WHERE id = $1 AND published_at IS NULL`,
      [id],
    );
  }

  async markFailed(id: string, backoffMs = 5_000): Promise<void> {
    await this.database.query(
      `UPDATE outbox_events
       SET attempts = attempts + 1,
           available_at = now() + ($2 || ' milliseconds')::interval
       WHERE id = $1`,
      [id, backoffMs],
    );
  }
}

export function createOutboxEventBus(args: {
  database: Database;
  queue: Queue;
  local: EventBus;
  logger: KernelLogger;
}): EventBus {
  const store = new OutboxStore(args.database);

  const deliver = async (id: string): Promise<void> => {
    const row = await store.get(id);
    if (!row || row.publishedAt) return;
    try {
      await args.local.publish(row.topic, row.payload);
      await store.markPublished(id);
    } catch (err) {
      await store.markFailed(id, Math.min(60_000, 1_000 * 2 ** Math.min(6, row.attempts)));
      args.logger.warn(
        { event: row.topic, outboxId: id, err: (err as Error).message },
        'outbox delivery failed; retry scheduled',
      );
    }
  };

  args.queue.subscribe('outbox.deliver', async (payload) => {
    const id = (payload as { id?: string }).id;
    if (id) await deliver(id);
  });

  return {
    async publish(event, payload) {
      const id = await store.enqueue(event, payload);
      await args.queue.enqueue('outbox.deliver', { id }, { idempotencyKey: `outbox:${id}` });
      await deliver(id);
    },
    subscribe(event, handler) {
      args.local.subscribe(event, handler);
    },
  };
}
