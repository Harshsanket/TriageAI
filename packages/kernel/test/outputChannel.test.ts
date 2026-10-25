import { describe, expect, it } from 'vitest';

import { AppError } from '../src/errors.js';
import { createOutputChannelRegistry } from '../src/outputChannel.js';

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
});
