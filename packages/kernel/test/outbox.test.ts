import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { EventBus } from '../src/eventbus.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { createOutboxEventBus, OutboxStore } from '../src/outbox.js';
import type { Queue, QueueSubscription } from '../src/queue/types.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type { KernelLogger } from '../src/types.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function fakeQueue(): {
  queue: Queue;
  jobs: Array<{ name: string; payload: unknown }>;
  handlers: Map<string, (payload: unknown) => Promise<void>>;
} {
  const jobs: Array<{ name: string; payload: unknown }> = [];
  const handlers = new Map<string, (payload: unknown) => Promise<void>>();
  const queue: Queue = {
    async enqueue(name, payload) {
      jobs.push({ name, payload });
      return { id: `job-${jobs.length}`, deduped: false };
    },
    subscribe(name, handler) {
      handlers.set(name, async (payload) => {
        await (handler as (payload: unknown) => Promise<void> | void)(payload);
      });
      return { name, stop: async () => undefined } as QueueSubscription;
    },
    async deadLetter() {
      return [];
    },
    async drain() {
      return undefined;
    },
    async close() {
      return undefined;
    },
  };
  return { queue, jobs, handlers };
}

describeIfDb('transactional outbox (phase 18)', () => {
  let database: PostgresDatabase;

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
    await database.query(`DELETE FROM outbox_events`);
  });
  afterAll(async () => {
    await database.query(`DELETE FROM outbox_events`);
    await database.close();
  });

  it('persists before delivery, enqueues a retry and publishes once', async () => {
    const { queue, jobs } = fakeQueue();
    const received: unknown[] = [];
    const local: EventBus = {
      async publish(_event, payload) {
        received.push(payload);
      },
      subscribe: () => undefined,
    };
    const bus = createOutboxEventBus({ database, queue, local, logger });
    await bus.publish('support.ticket.created', { ticketId: 't1' });

    expect(received).toEqual([{ ticketId: 't1' }]);
    expect(jobs[0]).toMatchObject({ name: 'outbox.deliver' });
    const rows = await database.query<{ published_at: string | null }>(
      `SELECT published_at FROM outbox_events`,
    );
    expect(rows[0]?.published_at).toBeTruthy();
  });

  it('leaves the event pending when local delivery fails and retries later', async () => {
    const { queue, handlers } = fakeQueue();
    let fail = true;
    const local: EventBus = {
      async publish() {
        if (fail) throw new Error('subscriber crashed');
      },
      subscribe: () => undefined,
    };
    const bus = createOutboxEventBus({ database, queue, local, logger });
    await bus.publish('support.ticket.status_changed', { ticketId: 't2' });
    const stored = await database.query<{ id: string; published_at: string | null }>(
      `SELECT id, published_at FROM outbox_events WHERE topic = 'support.ticket.status_changed'`,
    );
    expect(stored[0]?.published_at).toBeNull();

    fail = false;
    const row = stored[0];
    await handlers.get('outbox.deliver')?.({ id: row?.id });
    const after = await new OutboxStore(database).get(row?.id ?? '');
    expect(after?.publishedAt).toBeTruthy();
  });
});
