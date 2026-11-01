import { describe, expect, it, vi } from 'vitest';

import { GrantsEngine, normalizePermissions } from '../src/grants.js';
import { Mp1Broker, mp1Request } from '../src/mp1/broker.js';
import { Mp1Signer } from '../src/mp1/signer.js';

const permissions = normalizePermissions({
  events: { publish: ['demo.changed'], subscribe: ['other.ready'] },
  capabilities: { consume: ['embedder'], provide: [] },
  knowledge: { read: ['demo_docs'], write: [] },
});

function build(handlers: ConstructorParameters<typeof Mp1Broker>[0]['handlers'] = {}) {
  const audit = vi.fn();
  const grants = new GrantsEngine('demo', permissions);
  const other = new GrantsEngine('other', normalizePermissions({}));
  const broker = new Mp1Broker({
    handlers: {
      'runs.get': async (payload, context) => ({
        id: (payload as { id: string }).id,
        from: context.principal,
      }),
      'event.publish': async (payload) => ({ published: (payload as { event: string }).event }),
      ...handlers,
    },
    grantsFor: (moduleId) => (moduleId === 'demo' ? grants : moduleId === 'other' ? other : null),
    agentGrantsFor: (agentId) =>
      agentId === 'worker'
        ? new GrantsEngine('demo', normalizePermissions({ events: { publish: [], subscribe: [] } }))
        : null,
    audit,
    signer: Mp1Signer.generate('test-core'),
  });
  return { broker, audit };
}

const request = (overrides: Partial<Parameters<typeof mp1Request>[0]> = {}) =>
  mp1Request({
    op: 'runs.get',
    from: 'module:demo@1.0.0',
    to: 'core',
    schema: 'mp1.runs.get@1',
    payload: { id: 'run-1' },
    ...overrides,
  });

describe('MP1 broker (ADR-0055)', () => {
  it('validates, dispatches, signs and audits a request', async () => {
    const { broker, audit } = build();
    const response = await broker.dispatch(request(), 'module:demo@1.0.0');
    expect(response.kind).toBe('response');
    expect(response.payload).toEqual({ id: 'run-1', from: 'module:demo@1.0.0' });
    expect(response.coreSig).toBeTruthy();
    expect(broker.signer.verify(response)).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ op: 'runs.get', outcome: 'ok', from: 'module:demo@1.0.0' }),
    );
  });

  it('stamps from transport identity instead of trusting the sender claim', async () => {
    const { broker } = build();
    const response = await broker.dispatch(request(), 'module:other@1.0.0');
    expect(response.error).toBeUndefined();
    expect(response.payload).toEqual({ id: 'run-1', from: 'module:other@1.0.0' });
  });

  it('refuses an event outside the publisher namespace', async () => {
    const { broker } = build();
    const response = await broker.dispatch(
      request({
        op: 'event.publish',
        schema: 'mp1.event.publish@1',
        payload: { event: 'support.ticket.created', payload: {} },
      }),
      'module:demo@1.0.0',
    );
    expect(response.error?.code).toBe('kernel.POLICY_BLOCKED');
  });

  it('rejects expired deadlines and replayed ids', async () => {
    const { broker } = build();
    const expired = request({ now: Date.now() - 60_000, deadlineMs: 1_000 });
    const expiredResponse = await broker.dispatch(expired, 'module:demo@1.0.0');
    expect(expiredResponse.error?.code).toBe('MP1_DEADLINE_EXPIRED');

    const replay = request();
    const first = await broker.dispatch(replay, 'module:demo@1.0.0');
    expect(first.error).toBeUndefined();
    const second = await broker.dispatch(replay, 'module:demo@1.0.0');
    expect(second.error?.code).toBe('MP1_REPLAY');
  });

  it('gives agents a subset of their module grants', async () => {
    const { broker } = build();
    const asAgent = await broker.dispatch(
      request({
        from: 'agent:worker/module:demo',
        op: 'event.publish',
        schema: 'mp1.event.publish@1',
        payload: { event: 'demo.changed', payload: {} },
      }),
      'agent:worker/module:demo',
    );
    expect(asAgent.error?.code).toBe('kernel.POLICY_BLOCKED');
  });

  it('rejects an unknown schema and an out-of-grant capability call', async () => {
    const { broker } = build();
    await expect(
      broker.dispatch(request({ schema: 'demo.unknown@1', payload: {} }), 'module:demo@1.0.0'),
    ).rejects.toThrow(/invalid MP1 envelope/);

    const response = await broker.dispatch(
      request({
        op: 'capability.call',
        schema: 'mp1.capability.call@1',
        payload: { capability: 'classifier', args: {} },
      }),
      'module:demo@1.0.0',
    );
    expect(response.error?.code).toBe('kernel.POLICY_BLOCKED');
  });
});
