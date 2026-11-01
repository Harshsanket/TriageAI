import { describe, expect, it, vi } from 'vitest';

import type { KernelContext } from '@triageai/kernel';

import { createLlmLocalModule } from '../src/index.js';

describe('local chat model provider (Phase 22.T11)', () => {
  it('provides chatModel from config and speaks the local wire shape', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        message: { content: 'hello' },
        prompt_eval_count: 5,
        eval_count: 2,
        done_reason: 'stop',
      }),
    );
    const module = createLlmLocalModule({ fetch: fetchMock as unknown as typeof fetch });
    let provided: unknown;
    const ctx = {
      moduleOptions: { model: 'tiny-test-model' },
      capabilities: { egress: undefined },
      provideCapability: (_id: string, impl: unknown) => {
        provided = impl;
      },
    } as unknown as KernelContext;
    module.register(ctx);
    const model = provided as {
      describe(): { model: string };
      chat(req: unknown): Promise<{ message: { content: string } }>;
    };
    expect(model.describe().model).toBe('tiny-test-model');
    const result = await model.chat({
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 10,
    });
    expect(result.message.content).toBe('hello');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
