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

function model(
  handler: (request: ChatRequest) => Promise<ChatResponse>,
  hosted = false,
): ChatModel {
  return {
    chat: handler,
    describe: () => ({
      provider: 'fake',
      model: 'fake-model',
      hosted,
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

describe('callModel routing, send gate and trust assembly (phase 18.9/18.10)', () => {
  const choiceTask = {
    ...task,
    id: 'decide.route',
    outputSchema: z.object({ choice: z.string() }).strict(),
  };

  it('uses resolveModel for routing and records its reason', async () => {
    const routed = model(async () => response('routed answer'));
    const configured = model(async () => response('configured answer'));
    const resolver = vi.fn().mockReturnValue({ chatModel: routed, reason: 'route:cheapest_local' });
    const result = await callModel(
      { chatModel: configured, resolveModel: resolver },
      task,
      context,
      { messages: [{ role: 'user', content: 'x' }] },
    );
    expect(result.response.message.content).toBe('routed answer');
    expect(result.trace.routingReason).toBe('route:cheapest_local');
    expect(resolver).toHaveBeenCalledWith({ task: task.id, stepName: context.stepName });
  });

  it('keeps the configured primary and reason without a resolver', async () => {
    const result = await callModel(
      { chatModel: model(async () => response('primary')) },
      task,
      context,
      { messages: [{ role: 'user', content: 'x' }] },
    );
    expect(result.response.message.content).toBe('primary');
    expect(result.trace.routingReason).toBe('configured_primary');
  });

  it('withholds blocked send-gate requests without calling the model', async () => {
    const chat = vi.fn();
    const traces: unknown[] = [];
    const err = await callModel(
      {
        chatModel: model(chat),
        onTrace: (trace) => {
          traces.push(trace);
        },
      },
      task,
      context,
      { messages: [{ role: 'user', content: 'x' }], sendGate: { sensitivity: 'secret' } },
    ).catch((caught: unknown) => caught);
    expect(chat).not.toHaveBeenCalled();
    expect(err).toMatchObject({
      code: 'model.SEND_GATE_BLOCKED',
      category: 'policy_blocked',
      retryable: false,
      statusCode: 403,
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      tokensIn: 0,
      tokensOut: 0,
      retries: 0,
      errorCategory: 'policy_blocked',
      errorCode: 'model.SEND_GATE_BLOCKED',
      securityEvents: ['send_gate:withheld:secret'],
    });
  });

  it('enforces the egress class ceiling before calling the model', async () => {
    const chat = vi.fn();
    await expect(
      callModel(
        { chatModel: model(chat) },
        task,
        { ...context, egressClass: 'internal' },
        { messages: [{ role: 'user', content: 'x' }], sendGate: { sensitivity: 'restricted' } },
      ),
    ).rejects.toMatchObject({ code: 'model.SEND_GATE_BLOCKED', category: 'policy_blocked' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('records redaction for internal content sent to a hosted model', async () => {
    const chat = vi.fn().mockResolvedValue(response('ok'));
    const result = await callModel({ chatModel: model(chat, true) }, task, context, {
      messages: [{ role: 'user', content: 'x' }],
      sendGate: { sensitivity: 'internal' },
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.trace.securityEvents).toEqual(['send_gate:redacted:pii_or_internal_redaction']);
  });

  it('records an allowed send for public content sent to a local model', async () => {
    const chat = vi.fn().mockResolvedValue(response('ok'));
    const result = await callModel({ chatModel: model(chat) }, task, context, {
      messages: [{ role: 'user', content: 'x' }],
      sendGate: { sensitivity: 'public' },
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.trace.securityEvents).toContain('send_gate:allowed');
  });

  it('assembles parts with data boundaries and hashes the assembled prompt', async () => {
    const chat = vi.fn().mockResolvedValue(response('ok'));
    const result = await callModel({ chatModel: model(chat) }, task, context, {
      messages: [],
      parts: [
        {
          trust: 'trusted_instruction',
          role: 'system',
          source: 'task:answer@1',
          content: 'Answer briefly.',
          sensitivity: 'public',
        },
        {
          trust: 'untrusted_data',
          role: 'tool',
          source: 'kb:doc1#c2',
          content: 'Refunds take 5 days.',
          sensitivity: 'internal',
        },
      ],
    });
    const sent = chat.mock.calls[0]?.[0] as ChatRequest;
    expect(sent.messages[0]).toMatchObject({ role: 'system', content: 'Answer briefly.' });
    expect(sent.messages[1]?.content).toContain('<<data id=kb:doc1#c2');
    expect(sent.messages[1]?.content).toContain('boundary=');
    expect(result.trace.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects trusted instructions outside the system role without calling the model', async () => {
    const chat = vi.fn();
    await expect(
      callModel({ chatModel: model(chat) }, task, context, {
        messages: [],
        parts: [
          {
            trust: 'trusted_instruction',
            role: 'user',
            source: 'task:answer@1',
            content: 'Answer briefly.',
            sensitivity: 'public',
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'model.TRUST_BOUNDARY_INVALID',
      category: 'validation',
      retryable: false,
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it('rejects an undeclared structured choice as a hijack attempt', async () => {
    const chat = vi.fn().mockResolvedValue(response('{"choice":"delete_everything"}'));
    const traces: unknown[] = [];
    const err = await callModel(
      {
        chatModel: model(chat),
        onTrace: (trace) => {
          traces.push(trace);
        },
      },
      choiceTask,
      context,
      {
        messages: [{ role: 'user', content: 'x' }],
        structured: true,
        choiceLabels: ['reply', 'escalate'],
      },
    ).catch((caught: unknown) => caught);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(err).toMatchObject({
      code: 'model.UNDECLARED_CHOICE',
      category: 'policy_blocked',
      retryable: false,
    });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ securityEvents: ['hijack:undeclared_choice'] });
  });

  it('passes a declared structured choice through', async () => {
    const chat = vi.fn().mockResolvedValue(response('{"choice":"reply"}'));
    const result = await callModel({ chatModel: model(chat) }, choiceTask, context, {
      messages: [{ role: 'user', content: 'x' }],
      structured: true,
      choiceLabels: ['reply', 'escalate'],
    });
    expect(result.parsed).toEqual({ choice: 'reply' });
    expect(result.trace.securityEvents).not.toContain('hijack:undeclared_choice');
  });

  it('sanitises unsafe model text and records the event', async () => {
    const chat = vi
      .fn()
      .mockResolvedValue(
        response('before <img src=x> mid <script>alert(1)</script> javascript:alert(1) after'),
      );
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
      { messages: [{ role: 'user', content: 'x' }] },
    );
    const content = result.response.message.content;
    expect(content).toContain('[image removed]');
    expect(content).not.toContain('<img');
    expect(content).not.toContain('<script');
    expect(content).not.toContain('javascript:');
    expect(traces[0]).toMatchObject({ securityEvents: ['output_sanitized'] });
  });
});
