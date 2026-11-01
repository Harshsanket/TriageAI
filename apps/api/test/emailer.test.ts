import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

const SECRET = 'email-test-secret';
let root: string;
let configPath: string;
let app: App | undefined;
let previousSecret: string | undefined;

const capabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), modelVersion: 'fake' }),
  },
  classifier: {
    classify: async () => ({
      category: 'billing',
      confidence: 0.9,
      margin: 0.4,
      method: 'zero-shot',
      modelVersion: 'fake',
      scores: [{ category: 'billing', score: 0.9 }],
    }),
  },
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

beforeEach(async () => {
  previousSecret = process.env.EMAIL_INBOUND_SECRET;
  process.env.EMAIL_INBOUND_SECRET = SECRET;
  root = await mkdtemp(path.join(tmpdir(), 'triageai-emailer-'));
  configPath = path.join(root, 'triage.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      profile: 'support',
      queue: { adapter: 'pg-queue', pollIntervalMs: 100 },
      modules: {
        support: { enabled: true },
        'ai-pipeline': { enabled: true },
        emailer: { enabled: true },
        echo: { enabled: false },
      },
      capabilities: {},
    }),
  );
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (previousSecret === undefined) delete process.env.EMAIL_INBOUND_SECRET;
  else process.env.EMAIL_INBOUND_SECRET = previousSecret;
  await rm(root, { recursive: true, force: true });
});

function sign(payload: unknown, timestamp = `${Math.floor(Date.now() / 1000)}`) {
  const raw = JSON.stringify(payload);
  return {
    raw,
    timestamp,
    headers: {
      'content-type': 'application/json',
      'x-emailer-timestamp': timestamp,
      'x-emailer-signature': `sha256=${createHmac('sha256', SECRET)
        .update(`${timestamp}.${raw}`)
        .digest('hex')}`,
    },
  };
}

describeIfDb('emailer (phase 13)', () => {
  it('rejects a stale signature and a replayed delivery', async () => {
    app = (await buildApp({ quiet: true, configPath, capabilities })) as App;
    const stale = sign(
      {
        messageId: `stale-${Date.now()}@customer.test`,
        from: 'customer@test.dev',
        subject: 'stale',
        text: 'old',
      },
      `${Math.floor(Date.now() / 1000) - 600}`,
    );
    const staleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/emailer/inbound',
      headers: stale.headers,
      payload: stale.raw,
    });
    expect(staleRes.statusCode).toBe(401);

    const fresh = sign({
      messageId: `replay-${Date.now()}@customer.test`,
      from: 'customer@test.dev',
      subject: 'replay',
      text: 'new',
    });
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/emailer/inbound',
      headers: fresh.headers,
      payload: fresh.raw,
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/emailer/inbound',
      headers: fresh.headers,
      payload: fresh.raw,
    });
    expect(second.json()).toMatchObject({ accepted: true, deduped: true });
  });

  it('turns a signed email into a ticket, threads the reply, and gates outbound mail', async () => {
    app = (await buildApp({ quiet: true, configPath, capabilities })) as App;

    const inbound = sign({
      messageId: `msg-1-${Date.now()}@customer.test`,
      from: 'customer@test.dev',
      to: 'support@test.dev',
      subject: 'My invoice is wrong',
      text: 'I was charged twice this month.',
    });
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/emailer/inbound',
      headers: inbound.headers,
      payload: inbound.raw,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ accepted: true, threaded: false });

    const thread = await waitFor(async () => {
      const res = await app?.inject({ method: 'GET', url: '/api/v1/emailer/threads' });
      const rows = res?.json() as Array<{ messageId: string; ticketId: string }> | undefined;
      return rows?.find((row) => row.ticketId && row.messageId.startsWith('msg-1-')) ?? null;
    });

    const ticket = await app.inject({
      method: 'GET',
      url: `/api/v1/support/tickets/${thread.ticketId}`,
    });
    expect(ticket.statusCode).toBe(200);
    expect((ticket.json() as { ticket: { requester: string } }).ticket.requester).toBe(
      'customer@test.dev',
    );

    const reply = sign({
      messageId: `msg-2-${Date.now()}@customer.test`,
      inReplyTo: (await app!.inject({ method: 'GET', url: '/api/v1/emailer/threads' }))
        .json()
        .find((row: { messageId: string }) => row.messageId.startsWith('msg-1-'))?.messageId,
      from: 'customer@test.dev',
      subject: 'Re: My invoice is wrong',
      text: 'Still broken, please help.',
    });
    const replied = await app.inject({
      method: 'POST',
      url: '/api/v1/emailer/inbound',
      headers: reply.headers,
      payload: reply.raw,
    });
    expect(replied.json()).toMatchObject({ threaded: true, ticketId: thread.ticketId });

    const updated = await waitFor(async () => {
      const res = await app?.inject({
        method: 'GET',
        url: `/api/v1/support/tickets/${thread.ticketId}`,
      });
      const body = res?.json() as
        { ticket: { status: string }; messages: Array<{ body: string }> } | undefined;
      return body?.messages.some((message) => message.body.includes('Still broken')) ? body : null;
    });
    expect(updated.ticket.status).toBe('HUMAN_REVIEW');

    const send = await app.inject({
      method: 'POST',
      url: '/api/v1/emailer/send',
      payload: {
        to: 'customer@test.dev',
        subject: 'Re: My invoice is wrong',
        body: 'We fixed the invoice.',
        ticketId: thread.ticketId,
      },
    });
    expect(send.statusCode).toBe(200);
    const { outboxId } = send.json() as { outboxId: string };
    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/emailer/outbox/${outboxId}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    const outbox = await app.inject({ method: 'GET', url: '/api/v1/emailer/outbox' });
    expect(
      (outbox.json() as Array<{ status: string; error: string | null }>).find(
        (row) => row.status === 'failed' && /SMTP is not configured/.test(row.error ?? ''),
      ),
    ).toBeTruthy();
  });

  it('refuses an unsigned or incorrectly signed email', async () => {
    app = (await buildApp({ quiet: true, configPath, capabilities })) as App;
    const payload = JSON.stringify({
      messageId: 'msg-3@x',
      from: 'a@b.co',
      subject: 'x',
      text: 'y',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/emailer/inbound',
      headers: {
        'content-type': 'application/json',
        'x-emailer-timestamp': `${Math.floor(Date.now() / 1000)}`,
        'x-emailer-signature': 'sha256=nope',
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'emailer.SIGNATURE_INVALID' });
  });
});
