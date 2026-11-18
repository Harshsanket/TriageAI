import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import type { ChatModel, Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { AuthService } from '../src/platform/auth/service.js';
import { config } from '../src/platform/config.js';
import { registerActivityRoutes } from '../src/routes/activity.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

type App = FastifyInstance & { kernel?: Kernel };

function mockModel(content: string): ChatModel & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    async chat() {
      state.calls += 1;
      return {
        message: { role: 'assistant' as const, content },
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end' as const,
        modelVersion: 'fake',
      };
    },
    describe() {
      return {
        provider: 'fake',
        model: 'fake',
        hosted: false,
        contextWindow: 4096,
        maxOutput: 512,
        supportsTools: false,
        supportsStreaming: false,
      };
    },
  };
}

describeIfDb('activity search API (phase 18.6)', () => {
  let app: App;
  let dir: string;
  const suffix = ulid().toLowerCase();
  const users = {
    admin: { email: `activity-admin-${suffix}@test.dev`, password: 'admin-password-123' },
    agent: { email: `activity-agent-${suffix}@test.dev`, password: 'agent-password-123' },
    customer: { email: `activity-customer-${suffix}@test.dev`, password: 'customer-password-123' },
  };
  const tokens: Record<keyof typeof users, string> = { admin: '', agent: '', customer: '' };
  const actor = `activity-api-${suffix}`;

  async function call(who: keyof typeof users, url: string) {
    return app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${tokens[who]}` },
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'triageai-activity-'));
    const configPath = join(dir, 'triage.config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        profile: 'core',
        modules: { echo: { enabled: true }, chat: { enabled: false } },
        capabilities: {},
      }),
    );
    app = (await buildApp({
      quiet: true,
      configPath,
      authMode: 'required',
      rateLimit: { max: 0 },
    })) as App;
    const service = new AuthService(app.kernel!.database, {
      accessTtlSeconds: config.authAccessTtlSeconds,
      refreshTtlSeconds: config.authRefreshTtlSeconds,
      jwtSecret: config.authJwtSecret,
    });
    for (const [name, user] of Object.entries(users) as Array<
      [keyof typeof users, typeof users.admin]
    >) {
      const role = name === 'admin' ? 'admin' : name === 'agent' ? 'agent' : 'customer';
      await service.createUser({ ...user, name, role, actor: 'test' });
      tokens[name] = (await service.login(user.email, user.password)).accessToken;
    }
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await app.kernel!.database.query(
      `INSERT INTO activity_events (id, at, actor, kind, subject, summary, refs)
       VALUES ($1, $2, $3, 'run', $4, $5, '[]'::jsonb)`,
      [
        ulid(),
        yesterday.toISOString(),
        actor,
        `${actor}-run`,
        `run SUCCEEDED: ${actor} billing sync`,
      ],
    );
    await app.kernel!.database.query(
      `INSERT INTO activity_events (id, at, actor, kind, subject, summary, refs)
       VALUES ($1, now(), $2, 'approval', $3, $4, '[]'::jsonb)`,
      [ulid(), actor, `${actor}-approval`, `approval requested: ${actor} refund`],
    );
  });

  afterAll(async () => {
    const db = app.kernel?.database;
    if (db) {
      await db.query(`DELETE FROM activity_events WHERE actor = $1`, [actor]);
      await db.query(`DELETE FROM users WHERE email LIKE $1`, [`activity-%-${suffix}@test.dev`]);
    }
    await app?.close();
  });

  it('filters by actor, kind and text', async () => {
    const res = await call(
      'agent',
      `/api/v1/activity?actors=${encodeURIComponent(actor)}&kinds=run&text=billing`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ kind: string; summary: string }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ kind: 'run' });
    expect(body.events[0]?.summary).toContain('billing sync');
  });

  it('parses a natural-language date deterministically', async () => {
    const res = await call(
      'agent',
      `/api/v1/activity?q=${encodeURIComponent(`${actor} yesterday`)}`,
    );
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      source: string;
      query: { timeRange: { from: string; to: string } };
      events: Array<{ summary: string }>;
    };
    expect(body.source).toBe('deterministic');
    expect(body.events.some((event) => event.summary.includes(actor))).toBe(true);
  });

  it('is admin/agent only', async () => {
    expect((await call('admin', '/api/v1/activity')).statusCode).toBe(200);
    expect((await call('customer', '/api/v1/activity')).statusCode).toBe(403);
  });

  it('uses an injected chat model once and stops when LLM is disabled', async () => {
    const rowId = ulid();
    await app.kernel!.database.query(
      `INSERT INTO activity_events (id, at, actor, kind, subject, summary, refs)
       VALUES ($1, '2001-01-10T09:00:00Z', $2, 'run', $3, $4, '[]'::jsonb)`,
      [rowId, actor, `${actor}-model-run`, `run SUCCEEDED: ${actor} billing sync`],
    );
    const chatModel = mockModel(
      JSON.stringify({
        timeRange: { from: '2001-01-10T00:00:00.000Z', to: '2001-01-11T00:00:00.000Z' },
        kinds: ['run'],
        text: 'billing',
      }),
    );
    const bare = Fastify();
    registerActivityRoutes(bare, app.kernel!, { chatModel });
    try {
      const first = await bare.inject({
        method: 'GET',
        url: '/api/v1/activity?q=billing%20runs%20last%20Tuesday',
      });
      expect(first.statusCode).toBe(200);
      const body = first.json() as { source: string; events: Array<{ summary: string }> };
      expect(body.source).toBe('model');
      expect(chatModel.calls).toBe(1);
      expect(body.events.some((event) => event.summary.includes('billing sync'))).toBe(true);

      await app.kernel!.database.query(
        `INSERT INTO settings (key, value) VALUES ('controls', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [{ llmDisabled: true }],
      );
      const disabled = await bare.inject({
        method: 'GET',
        url: '/api/v1/activity?q=billing%20runs%20last%20Tuesday',
      });
      expect((disabled.json() as { source: string }).source).toBe('keyword');
      expect(chatModel.calls).toBe(1);
    } finally {
      await app.kernel!.database.query(`DELETE FROM settings WHERE key = 'controls'`);
      await app.kernel!.database.query(`DELETE FROM activity_events WHERE id = $1`, [rowId]);
      await bare.close();
    }
  });
});
