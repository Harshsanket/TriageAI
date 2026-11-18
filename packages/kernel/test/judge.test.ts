import { describe, expect, it } from 'vitest';

import type { ChatModel, ChatRequest, ChatResponse } from '../src/types.js';
import { judgeRun, JudgeOutputSchema, judgeTask, shouldSuspend } from '../src/evals/judge.js';

function fakeModel(reply: (request: ChatRequest) => string): ChatModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    calls,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      calls.push(request);
      return {
        message: { role: 'assistant', content: reply(request) },
        toolCalls: [],
        usage: { inputTokens: 12, outputTokens: 8 },
        stopReason: 'end',
        modelVersion: 'fake-judge-1',
      };
    },
    describe: () => ({
      provider: 'fake',
      model: 'fake-judge',
      hosted: false,
      contextWindow: 8_192,
      maxOutput: 1_024,
      supportsTools: false,
      supportsStreaming: false,
    }),
  };
}

const input = {
  runId: 'run-1',
  workflowId: 'support.triage',
  output: { answer: 'Reset your password from Settings.' },
  trajectory: [{ nodeId: 'answer', kind: 'stage' as const }],
};

describe('judge model (phase 18.T1)', () => {
  it('returns a judge EvalScore from valid structured output', async () => {
    const model = fakeModel(() =>
      JSON.stringify({ score: 0.92, findings: ['grounded'], verdict: 'pass' }),
    );
    const score = await judgeRun({ chatModel: model }, { ...input, hostedModel: true });
    expect(score).toMatchObject({
      runId: 'run-1',
      method: 'judge',
      evaluator: 'judge.answer-quality@1',
      score: 0.92,
      passed: true,
      floor: 0.8,
      findings: ['grounded'],
    });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.maxTokens).toBe(512);
    expect(JSON.stringify(model.calls[0]?.messages)).toContain('support.triage');
  });

  it('rejects invalid structured output after one repair attempt', async () => {
    const model = fakeModel(() => 'I think this run was good.');
    await expect(
      judgeRun({ chatModel: model }, { ...input, hostedModel: true }),
    ).rejects.toMatchObject({ code: 'model.INVALID_STRUCTURED_OUTPUT' });
    expect(model.calls).toHaveLength(2);
  });

  it('routes to the judge-tier model through resolveModel', async () => {
    const primary = fakeModel(() => 'primary should not be used');
    const judge = fakeModel(() => JSON.stringify({ score: 0.8, findings: [], verdict: 'pass' }));
    const score = await judgeRun(
      { chatModel: primary, judgeModel: judge },
      { ...input, hostedModel: true },
    );
    expect(score?.passed).toBe(true);
    expect(primary.calls).toHaveLength(0);
    expect(judge.calls).toHaveLength(1);
  });

  it('never calls the model when deterministic sampling says no', async () => {
    const model = fakeModel(() => JSON.stringify({ score: 1, findings: [], verdict: 'pass' }));
    const score = await judgeRun({ chatModel: model }, { ...input, baseRate: 0 });
    expect(score).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it('declares the bounded judge task and validates the score range', () => {
    expect(judgeTask()).toMatchObject({
      id: 'judge',
      maxOutputTokens: 512,
      timeoutMs: 30_000,
      requiredFields: ['score', 'findings', 'verdict'],
    });
    expect(JudgeOutputSchema.safeParse({ score: 1.1, findings: [], verdict: 'pass' }).success).toBe(
      false,
    );
  });
});

describe('judge suspension (phase 18.T1)', () => {
  it('suspends after three consecutive below-floor agreements', () => {
    expect(shouldSuspend([0.9, 0.4, 0.5, 0.3])).toBe(true);
    expect(shouldSuspend([0.9, 0.4, 0.5])).toBe(false);
    expect(shouldSuspend([0.9, 0.85, 0.4, 0.5])).toBe(false);
    expect(shouldSuspend([0.9, 0.4, 0.5, 0.3], { consecutiveFailures: 2 })).toBe(true);
    expect(
      shouldSuspend([
        { score: 0.9, passed: true },
        { score: 0.4, passed: false },
        { score: 0.5, passed: false },
        { score: 0.3, passed: false },
      ]),
    ).toBe(true);
  });
});
