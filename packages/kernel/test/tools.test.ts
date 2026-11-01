import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ToolContractError, ToolRegistry, validateToolDefinition } from '../src/tools/index.js';
import type { ToolContext, ToolDefinition } from '../src/tools/index.js';

const ctx: ToolContext = {
  runId: 'run-1',
  stepId: 'step-1',
  grantedScopes: ['kb:read'],
  egressClass: 'internal',
  org: { ownsEmail: () => true },
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
};

const base = {
  name: 'kb.search',
  version: '1.0.0',
  owner: 'kb',
  description: 'Search approved knowledge chunks by meaning. Use for factual questions.',
  examples: [{ query: 'refunds' }],
  input: z.object({ query: z.string().min(1) }).strict(),
  output: z.object({ hits: z.array(z.string()) }).strict(),
  access: 'read' as const,
  risk: 'low' as const,
  scopes: ['kb:read'],
  egressClass: 'internal' as const,
  idempotent: true,
  timeoutMs: 1_000,
  undo: 'free' as const,
  retry: {
    maxAttempts: 2,
    backoff: 'fixed' as const,
    retryOn: ['timeout', 'dependency_unavailable'] as const,
  },
  handler: async (input: { query: string }) => ({ hits: [input.query] }),
} satisfies ToolDefinition<{ query: string }, { hits: string[] }>;

describe('tool registry (phase 15)', () => {
  it('registers a complete tool and lists its metadata', () => {
    const registry = new ToolRegistry();
    registry.register(base);
    expect(registry.list()).toEqual([
      expect.objectContaining({ name: 'kb.search', access: 'read', risk: 'low', undo: 'free' }),
    ]);
  });

  it('refuses an incomplete contract', () => {
    expect(
      validateToolDefinition({ ...base, name: 'kb.delete_thing', access: 'write', undo: 'free' }),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/always high risk/)]));
    expect(validateToolDefinition({ ...base, undo: 'compensable', compensate: undefined })).toEqual(
      expect.arrayContaining([expect.stringMatching(/requires compensate/)]),
    );
    expect(
      validateToolDefinition({
        ...base,
        name: 'crm.create_deal',
        access: 'write',
        risk: 'high',
        undo: 'free',
        preview: undefined,
      } as never),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/must implement preview/)]));
    expect(() => new ToolRegistry().register({ ...base, description: 'short' })).toThrow(
      ToolContractError,
    );
  });

  it('validates input and output and returns short errors', async () => {
    const registry = new ToolRegistry();
    registry.register(base);
    const invalid = await registry.invoke('kb.search', {}, ctx);
    expect(invalid).toMatchObject({ ok: false, error: { category: 'validation' } });

    const broken = new ToolRegistry();
    broken.register({
      ...base,
      name: 'kb.list_hits',
      handler: (async () => ({ hits: 'nope' })) as never,
    });
    const badOutput = await broken.invoke('kb.list_hits', { query: 'x' }, ctx);
    expect(badOutput).toMatchObject({ ok: false, error: { code: 'tool.INVALID_OUTPUT' } });
  });

  it('requires approval for writes and refuses missing scopes', async () => {
    const registry = new ToolRegistry();
    registry.register({
      ...base,
      name: 'kb.create_note',
      access: 'write',
      risk: 'low',
      undo: 'free',
      handler: async () => ({ hits: [] }),
    });
    expect(await registry.invoke('kb.create_note', { query: 'x' }, ctx)).toMatchObject({
      ok: false,
      error: { code: 'tool.APPROVAL_REQUIRED' },
    });
    expect(
      await registry.invoke('kb.create_note', { query: 'x' }, { ...ctx, grantedScopes: [] }),
    ).toMatchObject({ ok: false, error: { code: 'tool.FORBIDDEN' } });
    expect(
      await registry.invoke('kb.create_note', { query: 'x' }, ctx, { approved: true }),
    ).toMatchObject({ ok: true });
  });

  it('honours the timeout and does not retry non-idempotent writes', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ hits: [] }), 200);
        }),
    );
    registry.register({
      ...base,
      name: 'kb.update_note',
      access: 'write',
      idempotent: false,
      timeoutMs: 20,
      handler: handler as never,
    });
    const result = await registry.invoke('kb.update_note', { query: 'x' }, ctx, { approved: true });
    expect(result).toMatchObject({ ok: false, error: { category: 'timeout' } });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
