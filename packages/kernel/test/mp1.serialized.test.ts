import { describe, expect, it } from 'vitest';

import { mp1RoundTrip, serializedTransportEnabled } from '../src/mp1/serialized.js';

describe('serialized in-process MP1 transport (Phase 22.T7)', () => {
  it('round-trips a validated request and response', async () => {
    const result = await mp1RoundTrip(
      {
        moduleId: 'demo',
        moduleVersion: '1.0.0',
        op: 'runs.get',
        schema: 'mp1.runs.get@1',
        payload: { id: 'run-1' },
      },
      async () => ({ id: 'run-1' }),
    );
    expect(result).toEqual({ id: 'run-1' });
  });

  it('refuses an invalid payload before executing', async () => {
    let called = false;
    await expect(
      mp1RoundTrip(
        {
          moduleId: 'demo',
          moduleVersion: '1.0.0',
          op: 'runs.get',
          schema: 'mp1.runs.get@1',
          payload: { id: 42 },
        },
        async () => {
          called = true;
          return null;
        },
      ),
    ).rejects.toThrow(/invalid/);
    expect(called).toBe(false);
  });

  it('reads the transport flag from the environment', () => {
    expect(serializedTransportEnabled({ TRIAGEAI_MODULE_TRANSPORT: 'serialized' })).toBe(true);
    expect(serializedTransportEnabled({})).toBe(false);
  });
});
