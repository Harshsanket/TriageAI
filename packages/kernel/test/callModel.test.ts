import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { dependencyUnavailable } from '../src/errors.js';
import { callModel, ModelCallError, qualityChecks } from '../src/models/callModel.js';
import type { ChatModel, ChatRequest, ChatResponse } from '../src/types.js';

function response(content: string, overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    message: { role: 'assistant', content },
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    stopReason: 'end',
    modelVersion: 'fake-1',
    ...overrides,
  };
}

function model(handler: (request: ChatRequest) => Promise<ChatResponse>): ChatModel {
  return {
    chat: handler,
    describe: () => ({
      provider: 'fake',
      model: 'fake-model',
      hosted: false,
      contextWindow: 8192,
      maxOutput: 2048,
      supportsTools: false,
      supportsStreaming: false,
    }),
  };
}

const task = {
  id: 'answer.support',
  promptTemplateId: 'answer',
  promptVersion: '1',
  outputSchema: z.object({ answer: z.string() }).strict(),
  maxOutputTokens: 64,
  timeoutMs: 100,
  requiredFields: [],
};

const context = { runId: 'run-1', workflowId: 'chat.reply', stepName: 'generate' };

describe('callModel wrapper (phase 18.9)', () => {
  it('validates structured output, repairs once and records a complete trace', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(response('not json'))
      .mockResolvedValueOnce(response('{"answer":"five days"}'));
    const traces: unknown[] = [];
    const result = await callModel(
      {
        chatModel: model(chat),
        onTrace: (trace) => {
          traces.push(trace);
        },
      },
      task,
      context,
      { messages: [{ role: 'user', content: 'how long?' }], structured: true },
    );
    expect(result.parsed).toEqual({ answer: 'five days' });
    expect(result.trace.schemaValidFirstTry).toBe(false);
    expect(result.trace.fallbackUsed).toBe('repair');
    expect(result.trace).toMatchObject({
      runId: 'run-1',
      workflowId: 'chat.reply',
      stepName: 'generate',
      task: 'answer.support',
      tokensIn: 10,
      tokensOut: 5,
      qualityChecks: expect.any(Array),
    });
    expect(traces).toHaveLength(1);
  });

  it('retries retryable errors, then uses the fallback model', async () => {
    const primary = model(async () => {
      throw dependencyUnavailable('down');
    });
    const fallback = model(async () => response('fallback answer'));
    const result = await callModel({ chatModel: primary, fallbackModel: fallback }, task, context, {
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.response.message.content).toBe('fallback answer');
    expect(result.trace.fallbackUsed).toBe('fallback_model');
    expect(result.retries).toBe(2);
  });

  it('retries a transient failure before giving up', async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(dependencyUnavailable('down'))
      .mockResolvedValueOnce(response('ok'));
    const result = await callModel({ chatModel: model(chat) }, task, context, {
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.response.message.content).toBe('ok');
    expect(result.retries).toBe(1);
  });

  it('honours the timeout even when the adapter ignores the signal', async () => {
    const slow = model(() => new Promise(() => undefined));
    await expect(
      callModel({ chatModel: slow }, task, context, {
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(ModelCallError);
  });

  it('flags repetition and empty/refusal outputs', () => {
    const repeated = response('the same words here. '.repeat(20));
    expect(
      qualityChecks(repeated, {}).find((check) => check.check === 'no_repetition_loop'),
    ).toMatchObject({ passed: false });
    expect(
      qualityChecks(response(''), {}).find((check) => check.check === 'non_empty'),
    ).toMatchObject({ passed: false });
    expect(
      qualityChecks(response('I cannot answer that.'), { expectAnswer: true }).find(
        (check) => check.check === 'not_refused',
      ),
    ).toMatchObject({ passed: false });
  });
});
