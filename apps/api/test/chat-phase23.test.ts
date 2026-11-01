import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, Generator, Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

async function waitForAssistant(app: App, conversationId: string, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/conversations/${conversationId}`,
    });
    const body = res.json() as {
      messages: Array<{ role: string; content: string; citations: string[] }>;
    };
    const assistant = body.messages.find((message) => message.role === 'assistant');
    if (assistant) return assistant;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the assistant');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const generator: Generator = {
  generate: async (prompt) => {
    const sources = [
      ...prompt.matchAll(/<<<SOURCE \d+ ref="([^"]+)">>>\n([\s\S]*?)\n<<<END SOURCE \d+>>>/g),
    ].map((match) => ({ ref: match[1] as string, text: match[2] as string }));
    if (sources[0]) return { text: sources[0].text, modelVersion: 'fake' };
    if (prompt.includes('2 + 2')) return { text: '4', modelVersion: 'fake' };
    if (/\bhi\b/i.test(prompt.split('Question:').at(-1) ?? '')) {
      return { text: 'Hello! How can I help?', modelVersion: 'fake' };
    }
    return { text: 'A general answer.', modelVersion: 'fake' };
  },
};

const capabilities: Capabilities = {
  retriever: {
    search: async (_collection, query) => {
      const sufficient = /refund/i.test(query);
      return {
        chunks: sufficient
          ? [
              {
                id: 'chunk-refund',
                collection: 'chat_modes',
                documentId: 'doc-refund',
                text: 'Refunds take five business days.',
                embedding: [1, 0],
                metadata: { approved: true, sourceEnabled: true, title: 'Refund policy' },
                score: 0.94,
              },
            ]
          : [],
        gate: {
          sufficient,
          topScore: sufficient ? 0.94 : 0,
          margin: sufficient ? 0.5 : 0,
          threshold: 0.35,
          marginThreshold: 0.05,
        },
      };
    },
  },
  generator,
};

let app: App | undefined;
let root: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function boot(mode: 'prefer' | 'only'): Promise<App> {
  root = await mkdtemp(path.join(tmpdir(), 'triageai-chat-modes-'));
  const configPath = path.join(root, 'triage.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      profile: 'core',
      queue: { adapter: 'pg-queue', pollIntervalMs: 100 },
      modules: {
        chat: { enabled: true, options: { collection: 'chat_modes', knowledgeMode: mode } },
        'ai-pipeline': { enabled: true },
      },
      capabilities: {},
    }),
  );
  app = (await buildApp({ quiet: true, configPath, capabilities, setup: false })) as App;
  return app;
}

async function ask(target: App, text: string) {
  const sent = await target.inject({
    method: 'POST',
    url: '/api/v1/chat/messages',
    payload: { text },
  });
  expect(sent.statusCode).toBe(200);
  return waitForAssistant(target, (sent.json() as { conversationId: string }).conversationId);
}

describeIfDb('chat knowledge modes (phase 23.3)', () => {
  it('prefer: answers general questions and small talk, and cites knowledge', async () => {
    const target = await boot('prefer');

    const math = await ask(target, 'What is 2 + 2?');
    expect(math.content).toContain('4');
    expect(math.citations).toEqual([]);

    const greeting = await ask(target, 'hi');
    expect(greeting.content).toContain('Hello!');
    expect(greeting.content).not.toMatch(/could not verify/i);

    const grounded = await ask(target, 'how long do refunds take');
    expect(grounded.content).toContain('Refunds take five business days.');
    expect(grounded.content).toContain('[Refund policy]');
    expect(grounded.citations).toEqual(['Refund policy']);
  });

  it('only: keeps the strict refusal but still answers small talk', async () => {
    const target = await boot('only');

    const math = await ask(target, 'What is 2 + 2?');
    expect(math.content).toMatch(/could not verify/i);
    expect(math.content).not.toContain('General answer:');

    const greeting = await ask(target, 'hi');
    expect(greeting.content).toContain('Hello!');
    expect(greeting.content).not.toMatch(/could not verify/i);
  });
});
