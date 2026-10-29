import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import type { Capabilities } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { config } from '../src/platform/config.js';
import { AuthService } from '../src/platform/auth/service.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

type App = FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };

const fakeCapabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), modelVersion: 'fake-mini' }),
  },
  classifier: {
    classify: async () => ({
      category: 'billing',
      confidence: 0.91,
      margin: 0.35,
      method: 'zero-shot',
      modelVersion: 'fake-mini',
      scores: [{ category: 'billing', score: 0.91 }],
    }),
  },
};

/**
 * Ownership ACL matrix (Phase 10A): a customer only ever sees and acts on
 * their own tickets and conversations; everything else is a 404 so ids cannot
 * be probed. Agents keep the full view.
 */
describeIfDb('ownership ACLs (phase 10A)', () => {
  let app: App;
  const suffix = ulid().toLowerCase();
  const users = {
    alice: { email: `own-alice-${suffix}@test.dev`, password: 'alice-password-123' },
    bob: { email: `own-bob-${suffix}@test.dev`, password: 'bob-password-123' },
    agent: { email: `own-agent-${suffix}@test.dev`, password: 'agent-password-123' },
  };
  const tokens: Record<keyof typeof users, string> = { alice: '', bob: '', agent: '' };

  async function call(who: keyof typeof users, method: string, url: string, payload?: unknown) {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { authorization: `Bearer ${tokens[who]}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triageai-own-'));
    const configPath = join(dir, 'triage.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        profile: 'support',
        modules: {
          support: { enabled: true },
          'ai-pipeline': { enabled: true },
          chat: { enabled: true },
          echo: { enabled: false },
        },
        capabilities: {
          embedder: { adapter: 'ai-service' },
          classifier: { adapter: 'ai-service' },
        },
      }),
    );
    app = (await buildApp({
      quiet: true,
      configPath,
      capabilities: fakeCapabilities,
      authMode: 'required',
      rateLimit: { max: 0 },
    })) as App;
    const service = new AuthService(app.kernel!.database, {
      accessTtlSeconds: config.authAccessTtlSeconds,
      refreshTtlSeconds: config.authRefreshTtlSeconds,
      jwtSecret: config.authJwtSecret,
    });
    for (const [name, user] of Object.entries(users) as Array<
      [keyof typeof users, typeof users.alice]
    >) {
      const role = name === 'agent' ? 'agent' : 'customer';
      await service.createUser({ ...user, name, role, actor: 'test' });
      tokens[name] = (await service.login(user.email, user.password)).accessToken;
    }
  });

  afterAll(async () => {
    await app.kernel!.database.query(`DELETE FROM users WHERE email LIKE $1`, [
      `own-%-${suffix}@test.dev`,
    ]);
    await app.close();
  });

  it('scopes tickets to their owner and hides internals from customers', async () => {
    const created = await call('alice', 'POST', '/api/v1/support/tickets', {
      subject: 'Invoice question',
      body: 'I was charged twice',
      requester: 'someone-else',
      idempotencyKey: `own-key-${suffix}`,
    });
    expect(created.status).toBe(200);
    const ticketId = created.body.ticketId as string;

    const own = await call('alice', 'GET', `/api/v1/support/tickets/${ticketId}`);
    expect(own.status).toBe(200);
    // The requester comes from the session, never the body.
    expect((own.body.ticket as { requester: string }).requester).toBe(users.alice.email);
    expect(own.body.events).toEqual([]);

    expect((await call('bob', 'GET', `/api/v1/support/tickets/${ticketId}`)).status).toBe(404);
    expect(
      (
        await call('bob', 'POST', `/api/v1/support/tickets/${ticketId}/confirmation`, {
          solved: true,
        })
      ).status,
    ).toBe(404);

    // Reusing another owner's idempotency key must not return their ticket.
    const replay = await call('bob', 'POST', '/api/v1/support/tickets', {
      subject: 'x',
      body: 'y',
      idempotencyKey: `own-key-${suffix}`,
    });
    expect(replay.status).toBe(409);
    expect(JSON.stringify(replay.body)).not.toContain(ticketId);

    const agentView = await call('agent', 'GET', `/api/v1/support/tickets/${ticketId}`);
    expect(agentView.status).toBe(200);
    expect((agentView.body.events as unknown[]).length).toBeGreaterThan(0);
  });

  it('scopes chat conversations to their owner', async () => {
    const created = await call('alice', 'POST', '/api/v1/chat/conversations', { title: 'mine' });
    expect(created.status).toBe(200);
    const conversationId = created.body.conversationId as string;

    const aliceList = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/chat/conversations',
        headers: { authorization: `Bearer ${tokens.alice}` },
      })
    ).json() as Array<{ id: string }>;
    expect(aliceList.map((c) => c.id)).toContain(conversationId);

    const bobList = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/chat/conversations',
        headers: { authorization: `Bearer ${tokens.bob}` },
      })
    ).json() as Array<{ id: string }>;
    expect(bobList.map((c) => c.id)).not.toContain(conversationId);

    expect((await call('bob', 'GET', `/api/v1/chat/conversations/${conversationId}`)).status).toBe(
      404,
    );
    expect(
      (
        await call('bob', 'POST', '/api/v1/chat/messages', {
          conversationId,
          text: 'let me in',
        })
      ).status,
    ).toBe(404);
  });
});
