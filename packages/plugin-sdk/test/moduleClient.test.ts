import { describe, expect, it } from 'vitest';

import type { Mp1Envelope } from '@triageai/contracts';

import { createModuleClient } from '../src/moduleClient.js';

function responseFor(request: Mp1Envelope, payload: unknown): Mp1Envelope {
  return {
    mp: '1.0',
    id: `response-${request.id}`,
    kind: 'response',
    op: request.op,
    from: 'core',
    to: request.from,
    schema: 'mp1.response@1',
    correlationId: request.id,
    deadline: new Date(Date.now() + 30_000).toISOString(),
    dataClass: request.dataClass,
    payload,
  };
}

const transport = {
  send: async (envelope: Mp1Envelope) => {
    const payload = envelope.payload as Record<string, unknown>;
    return responseFor(envelope, payload.id ? { id: payload.id } : payload);
  },
};

describe('TS module SDK (ADR-0055 §7)', () => {
  it('round-trips a validated request and response', async () => {
    const client = createModuleClient({ moduleId: 'demo', version: '1.0.0', transport });
    await expect(client.call('runs.get', 'mp1.runs.get@1', { id: 'run-1' })).resolves.toEqual({
      id: 'run-1',
    });
    await expect(
      client.call('knowledge.query', 'mp1.knowledge.query@1', {
        collection: 'docs',
        mode: 'read',
        operation: 'stats',
      }),
    ).resolves.toEqual({ collection: 'docs', mode: 'read', operation: 'stats' });
  });

  it('refuses to send an invalid payload before it reaches the transport', async () => {
    let sent = 0;
    const client = createModuleClient({
      moduleId: 'demo',
      version: '1.0.0',
      transport: {
        send: (envelope) => {
          sent += 1;
          return Promise.resolve(responseFor(envelope, {}));
        },
      },
    });
    await expect(client.call('runs.get', 'mp1.runs.get@1', { id: 42 } as never)).rejects.toThrow(
      /invalid MP1 envelope/,
    );
    expect(sent).toBe(0);
  });

  it('throws the error envelope for an unauthorized call', async () => {
    const client = createModuleClient({
      moduleId: 'demo',
      version: '1.0.0',
      transport: {
        send: async (envelope) => ({
          ...responseFor(envelope, null),
          payload: null,
          error: {
            type: 'https://triageai.dev/errors/POLICY_BLOCKED',
            title: 'POLICY_BLOCKED',
            status: 403,
            code: 'kernel.POLICY_BLOCKED',
            category: 'policy_blocked' as const,
            retryable: false,
            userMessage: 'not allowed',
            correlationId: envelope.id,
          },
        }),
      },
    });
    await expect(
      client.call('knowledge.query', 'mp1.knowledge.query@1', {
        collection: 'other',
        mode: 'read',
        operation: 'stats',
      }),
    ).rejects.toMatchObject({
      envelope: expect.objectContaining({ code: 'kernel.POLICY_BLOCKED' }),
    });
  });
});
