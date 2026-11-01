import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AppError, type ChatRequest, type ChatResponse } from '@triageai/kernel';

import {
  AnthropicChatModel,
  GoogleChatModel,
  OllamaChatModel,
  OpenAiCompatibleChatModel,
  assertHostedAllowed,
} from '../src/services/chatModels.js';

const request: ChatRequest = {
  messages: [
    { role: 'system', content: 'Be grounded.' },
    { role: 'user', content: 'How long do refunds take?' },
  ],
  maxTokens: 128,
  temperature: 0,
};

let server: Server;
let baseUrl: string;
const seen: Array<{ path: string; headers: Record<string, unknown>; body: string }> = [];
const testEgress = {
  allows: () => true,
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ path: req.url ?? '/', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/missing')) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      if (req.url?.includes('/api/chat')) {
        res.end(
          JSON.stringify({
            model: 'qwen2.5:1.5b',
            message: { role: 'assistant', content: 'Five days.' },
            prompt_eval_count: 20,
            eval_count: 4,
            done_reason: 'stop',
          }),
        );
        return;
      }
      if (req.url?.includes('/v1/messages')) {
        res.end(
          JSON.stringify({
            model: 'claude-test',
            content: [{ type: 'text', text: 'Five days.' }],
            usage: { input_tokens: 21, output_tokens: 5 },
            stop_reason: 'end_turn',
          }),
        );
        return;
      }
      if (req.url?.includes(':generateContent')) {
        res.end(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Five days.' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 22, candidatesTokenCount: 6 },
            modelVersion: 'gemini-test',
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          model: 'gpt-test',
          choices: [
            {
              message: { role: 'assistant', content: 'Five days.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 23, completion_tokens: 7 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('ChatModel adapters (phase 14)', () => {
  it('speaks Ollama native chat', async () => {
    const model = new OllamaChatModel({
      provider: 'ollama',
      model: 'qwen2.5:1.5b',
      baseUrl,
      hosted: false,
      contextWindow: 32768,
      maxOutput: 4096,
    });
    const result: ChatResponse = await model.chat(request);
    expect(result.message.content).toBe('Five days.');
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 4 });
    expect(model.describe()).toMatchObject({ provider: 'ollama', hosted: false });
  });

  it('speaks OpenAI-compatible chat', async () => {
    const model = new OpenAiCompatibleChatModel({
      provider: 'openai',
      model: 'gpt-test',
      baseUrl,
      apiKey: 'test-key',
      hosted: true,
      egress: testEgress,
      contextWindow: 128000,
      maxOutput: 4096,
    });
    const result = await model.chat(request);
    expect(result.message.content).toBe('Five days.');
    expect(result.modelVersion).toBe('gpt-test');
    const sent = seen.at(-1);
    expect(sent?.headers.authorization).toBe('Bearer test-key');
    expect(sent?.body).toContain('max_tokens');
  });

  it('speaks Anthropic Messages', async () => {
    const model = new AnthropicChatModel({
      provider: 'anthropic',
      model: 'claude-test',
      baseUrl,
      apiKey: 'anthropic-key',
      hosted: true,
      egress: testEgress,
      contextWindow: 200000,
      maxOutput: 4096,
    });
    const result = await model.chat(request);
    expect(result.message.content).toBe('Five days.');
    expect(result.usage).toMatchObject({ inputTokens: 21, outputTokens: 5 });
    const sent = seen.at(-1);
    expect(sent?.headers['x-api-key']).toBe('anthropic-key');
    expect(sent?.body).toContain('"system":"Be grounded."');
  });

  it('speaks Google generateContent', async () => {
    const model = new GoogleChatModel({
      provider: 'google',
      model: 'gemini-test',
      baseUrl,
      apiKey: 'google-key',
      hosted: true,
      egress: testEgress,
      contextWindow: 1_000_000,
      maxOutput: 8192,
    });
    const result = await model.chat(request);
    expect(result.message.content).toBe('Five days.');
    expect(result.modelVersion).toBe('gemini-test');
    expect(seen.at(-1)?.path).toContain('gemini-test:generateContent');
  });

  it('maps upstream errors to the taxonomy', async () => {
    const model = new OpenAiCompatibleChatModel({
      provider: 'openai',
      model: 'x',
      baseUrl: `${baseUrl}/missing`,
      hosted: true,
      egress: testEgress,
      contextWindow: 8192,
      maxOutput: 1024,
    });
    let failure: AppError | undefined;
    try {
      await model.chat(request);
    } catch (err) {
      failure = err as AppError;
    }
    expect(failure?.category).toBe('not_found');
    expect(failure?.retryable).toBe(false);
  });
});

describe('hosted egress gate (phase 14)', () => {
  it('refuses hosted adapters when disabled or not allowlisted', () => {
    expect(() =>
      assertHostedAllowed({
        adapter: 'anthropic',
        hosted: { enabled: false, allowedProviders: [] },
      }),
    ).toThrow(/disabled/);
    expect(() =>
      assertHostedAllowed({
        adapter: 'openai',
        hosted: { enabled: true, allowedProviders: ['anthropic'] },
      }),
    ).toThrow(/not in hosted.allowedProviders/);
    expect(() =>
      assertHostedAllowed({
        adapter: 'ollama',
        hosted: { enabled: false, allowedProviders: [] },
      }),
    ).not.toThrow();
  });
});
