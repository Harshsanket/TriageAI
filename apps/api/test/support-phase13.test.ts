import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import type { Capabilities, ClassificationResult, Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const SUPPORT_CONFIG = resolve(process.cwd(), '../../config/presets/support.json');
type App = FastifyInstance & { kernel?: Kernel };

const classification: ClassificationResult = {
  category: 'billing',
  confidence: 0.94,
  margin: 0.4,
  method: 'zero-shot',
  modelVersion: 'fake',
  scores: [{ category: 'billing', score: 0.94 }],
};

const capabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), modelVersion: 'fake' }),
  },
  classifier: { classify: async () => classification },
};

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out');
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

let app: App | undefined;
beforeEach(async () => {
  app = (await buildApp({
    quiet: true,
    configPath: SUPPORT_CONFIG,
    capabilities,
  })) as App;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describeIfDb('ticket solver completion (phase 13)', () => {
  it('sets an SLA, assigns, resolves, records CSAT and lists my tickets', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: 'Invoice issue', body: 'Charged twice' },
    });
    const { ticketId } = created.json() as { ticketId: string };

    const routed = await waitFor(async () => {
      const res = await app!.inject({ method: 'GET', url: `/api/v1/support/tickets/${ticketId}` });
      const body = res.json() as { ticket: { status: string; slaDueAt: string | null } };
      return body.ticket.status === 'ROUTED' ? body : null;
    });
    expect(routed.ticket.slaDueAt).toBeTruthy();

    const assigned = await app!.inject({
      method: 'PATCH',
      url: `/api/v1/support/tickets/${ticketId}/assignment`,
      payload: { assigneeId: 'agent-7' },
    });
    expect(assigned.statusCode).toBe(200);
    expect((assigned.json() as { assigneeId: string }).assigneeId).toBe('agent-7');

    const mine = await app!.inject({ method: 'GET', url: '/api/v1/support/my-tickets' });
    expect((mine.json() as Array<{ id: string }>).some((ticket) => ticket.id === ticketId)).toBe(
      true,
    );

    const resolved = await app!.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ticketId}/resolve`,
      payload: { actor: 'agent-7', note: 'fixed' },
    });
    expect(resolved.statusCode).toBe(200);

    const csat = await app!.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ticketId}/csat`,
      payload: { score: 5 },
    });
    expect(csat.statusCode).toBe(200);
    const again = await app!.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ticketId}/csat`,
      payload: { score: 1 },
    });
    expect(again.statusCode).toBe(409);
  });

  it('reports breaches and writes one event per ticket', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: 'Overdue', body: 'Please help' },
    });
    const { ticketId } = created.json() as { ticketId: string };
    await app!.kernel!.database.query(
      `UPDATE mod_support.support_tickets SET sla_due_at = now() - interval '1 hour' WHERE id = $1`,
      [ticketId],
    );

    const breaches = await app!.inject({ method: 'GET', url: '/api/v1/support/sla/breaches' });
    expect(breaches.statusCode).toBe(200);
    const rows = breaches.json() as Array<{ id: string; slaBreachedAt: string }>;
    expect(rows.find((row) => row.id === ticketId)?.slaBreachedAt).toBeTruthy();

    const events = await app!.kernel!.database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM mod_support.support_ticket_events
       WHERE ticket_id = $1 AND type = 'sla_breached'`,
      [ticketId],
    );
    expect(events[0]?.count).toBe(1);
  });

  it('stores canned responses', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/api/v1/support/canned-responses',
      payload: { title: 'Refund policy', body: 'Refunds take five days.' },
    });
    expect(created.statusCode).toBe(200);
    const listed = await app!.inject({ method: 'GET', url: '/api/v1/support/canned-responses' });
    expect(
      (listed.json() as Array<{ title: string }>).some((row) => row.title === 'Refund policy'),
    ).toBe(true);
  });
});
