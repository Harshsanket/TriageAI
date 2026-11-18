import { describe, expect, it } from 'vitest';

import { AppError, policyBlocked } from '../src/errors.js';
import { createOutputChannelRegistry } from '../src/outputChannel.js';
import { HttpOutputChannel } from '../src/outputChannel/http.js';

const ctx = {
  runId: 'run-1',
  workflowId: 'w',
  stageId: 's',
  orgId: null,
};

describe('OutputChannel registry', () => {
  it('routes a delivery to the registered channel', async () => {
    const registry = createOutputChannelRegistry();
    registry.register('test-channel', {
      deliver: async () => ({ ref: 'ref-1', channel: 'test-channel' }),
    });
    const result = await registry.deliver(ctx, { channel: 'test-channel', body: 'hi' });
    expect(result.ref).toBe('ref-1');
    expect(registry.has('test-channel')).toBe(true);
    expect(registry.channels()).toEqual(['test-channel']);
  });

  it('fails typed when a channel is not configured', async () => {
    const registry = createOutputChannelRegistry();
    await expect(registry.deliver(ctx, { channel: 'missing', body: 'hi' })).rejects.toMatchObject({
      code: 'INTEGRATION_DISABLED',
      statusCode: 503,
    });
    await expect(registry.search?.(ctx, { channel: 'missing', text: 'x' })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('refuses duplicate channel registration', () => {
    const registry = createOutputChannelRegistry();
    const adapter = { deliver: async () => ({ ref: 'r', channel: 'c' }) };
    registry.register('c', adapter);
    expect(() => registry.register('c', adapter)).toThrow(/already registered/);
  });

  it('runs the host guard before delivery and can be cleared', async () => {
    const registry = createOutputChannelRegistry();
    registry.register('c', { deliver: async () => ({ ref: 'r', channel: 'c' }) });
    registry.setGuard(() => {
      throw policyBlocked('read-only mode blocks outbound deliveries');
    });
    await expect(registry.deliver(ctx, { channel: 'c', body: 'hi' })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
      category: 'policy_blocked',
    });

    registry.setGuard(null);
    await expect(registry.deliver(ctx, { channel: 'c', body: 'hi' })).resolves.toMatchObject({
      ref: 'r',
    });
  });

  it('runs an adapter-level guard before an HTTP request', async () => {
    let fetched = 0;
    const channel = new HttpOutputChannel({
      channel: 'http-test',
      enabled: () => true,
      guard: () => {
        throw policyBlocked('blocked by the host guard');
      },
      request: () => ({ url: 'https://example.test/hook' }),
      parse: () => ({ ref: 'http-ref' }),
      fetchImpl: async () => {
        fetched += 1;
        return new Response('{}', { status: 200 });
      },
    });
    await expect(channel.deliver(ctx, { channel: 'http-test', body: 'hi' })).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
    expect(fetched).toBe(0);
  });
});
