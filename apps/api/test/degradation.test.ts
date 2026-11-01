import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import { dependencyUnavailable, type Capabilities, type Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { registerHealthRoutes } from '../src/routes/health.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const SUPPORT_CONFIG = resolve(process.cwd(), '../../config/presets/support.json');
const ASSISTANT_CONFIG = resolve(process.cwd(), '../../config/presets/assistant.json');

type App = FastifyInstance & { kernel?: Kernel };

function fakeCapabilities(overrides: Partial<Capabilities>): Capabilities {
  return {
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
    vectorStore: {
      upsert: async () => undefined,
      search: async () => [],
      deleteByDocument: async () => undefined,
    },
    ...overrides,
  };
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describeIfDb('graceful degradation (phase 10c)', () => {
  it('sends tickets to human review when the ai-service is down', async () => {
    app = (await buildApp({
      quiet: true,
      configPath: SUPPORT_CONFIG,
      capabilities: fakeCapabilities({
        classifier: {
          classify: async () => {
            throw dependencyUnavailable('ai-service is down');
          },
        },
      }),
    })) as App;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: 'Locked out', body: 'I cannot sign in' },
    });
    expect(created.statusCode).toBe(200);
    const { ticketId } = created.json() as { ticketId: string };

    const ticket = await waitFor(async () => {
      const res = await app?.inject({ method: 'GET', url: `/api/v1/support/tickets/${ticketId}` });
      const body = res?.json() as
        | { ticket: { status: string }; messages: Array<{ body: string; meta: unknown }> }
        | undefined;
      return body?.ticket.status === 'HUMAN_REVIEW' ? body : null;
    });

    expect(ticket.ticket.status).toBe('HUMAN_REVIEW');
    expect(ticket.messages.some((message) => /triage is unavailable/i.test(message.body))).toBe(
      true,
    );
  });

  it('tells the chat user when the model backend is unavailable', async () => {
    app = (await buildApp({
      quiet: true,
      configPath: ASSISTANT_CONFIG,
      capabilities: fakeCapabilities({
        retriever: {
          search: async () => ({
            chunks: [
              {
                id: 'c1',
                documentId: 'd1',
                text: 'Reset your password from the account page.',
                score: 0.9,
                metadata: { title: 'Password reset' },
              },
            ],
            gate: {
              sufficient: true,
              topScore: 0.9,
              margin: 0.4,
              threshold: 0.35,
              marginThreshold: 0.05,
            },
          }),
        },
        generator: {
          generate: async () => {
            throw dependencyUnavailable('ollama is unreachable');
          },
        },
      }),
    })) as App;

    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/chat/messages',
      payload: { text: 'How do I reset my password?' },
    });
    expect(sent.statusCode).toBe(200);
    const { conversationId } = sent.json() as { conversationId: string };

    const body = await waitFor(async () => {
      const res = await app?.inject({
        method: 'GET',
        url: `/api/v1/chat/conversations/${conversationId}`,
      });
      const payload = res?.json() as { messages: Array<{ role: string; content: string }> };
      const assistant = payload?.messages.find((message) => message.role === 'assistant');
      return assistant ? payload : null;
    });

    const assistant = body.messages.find((message) => message.role === 'assistant');
    expect(assistant?.content).toMatch(/temporarily unavailable/i);
  });

  it('returns 503 from readyz when the database is unreachable', async () => {
    const probe = Fastify({ logger: false });
    probe.decorate('kernel', {
      database: {
        query: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
        transaction: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
      },
    } as unknown as Kernel);
    await registerHealthRoutes(probe);
    const res = await probe.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'starting' });
    await probe.close();
  });
});

/**
 * Property-style guard: whatever a failing handler throws, a 5xx body must not
 * leak a stack trace, SQL or a secret (10C.T8).
 */
describe('5xx bodies never leak operator data (phase 10c)', () => {
  let appUnderTest: FastifyInstance;

  beforeAll(async () => {
    appUnderTest = await buildApp({ quiet: true, skipBoot: true });
    appUnderTest.get('/__boom/:kind', async (request) => {
      const kind = (request.params as { kind: string }).kind;
      if (kind === 'sql') throw new Error('SELECT * FROM secrets WHERE token = $1');
      if (kind === 'stack') throw new Error('boom\n    at /Users/op/apps/api/src/app.ts:42:7');
      if (kind === 'secret') {
        throw new Error('connect failed postgres://triageai:hunter2@db:5432/triageai');
      }
      throw new Error('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl');
    });
  });

  afterAll(async () => {
    await appUnderTest.close();
  });

  it('redacts secrets and hides stack traces in every sampled 5xx', async () => {
    for (const kind of ['sql', 'stack', 'secret', 'bearer']) {
      const res = await appUnderTest.inject({ method: 'GET', url: `/__boom/${kind}` });
      expect(res.statusCode).toBe(500);
      const text = res.body;
      expect(text).not.toMatch(/SELECT \*/);
      expect(text).not.toMatch(/\bat \/Users\//);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('postgres://');
      expect(text).not.toContain('eyJhbGci');
    }
  });
});
