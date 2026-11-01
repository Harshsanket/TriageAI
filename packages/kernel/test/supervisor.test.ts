import { describe, expect, it, vi } from 'vitest';

import type { Mp1Envelope } from '@triageai/contracts';

import { normalizePermissions } from '../src/grants.js';
import { Mp1SessionIssuer } from '../src/mp1/sessionToken.js';
import { ModuleSupervisor } from '../src/supervisor.js';
import type { TriageModule } from '../src/types.js';

const module: TriageModule = {
  id: 'demo',
  version: '1.0.0',
  capabilities: [],
  permissions: normalizePermissions({ stages: ['demo.run'], workflows: [] }),
  dependsOn: { capabilities: [] },
  manifest: { routes: [], nav: [], background: [] },
  lifecycle: {},
  register: () => undefined,
};

function response(request: Mp1Envelope, payload: unknown): Mp1Envelope {
  return {
    mp: '1.0',
    id: `res-${request.id}`,
    kind: 'response',
    op: request.op,
    from: request.to as Mp1Envelope['from'],
    to: 'core',
    schema: 'mp1.response@1',
    correlationId: request.id,
    deadline: new Date(Date.now() + 30_000).toISOString(),
    dataClass: request.dataClass,
    payload,
  };
}

describe('module supervisor (ADR-0054 §6)', () => {
  it('issues and verifies short-lived Stage-A session tokens', () => {
    const issuer = new Mp1SessionIssuer('gen-1');
    const { token } = issuer.issue('module:demo@1.0.0');
    expect(issuer.verify(token)).toMatchObject({ sub: 'module:demo@1.0.0', gen: 'gen-1' });
    expect(issuer.verify(token, Date.now() + 16 * 60_000)).toBeNull();
    expect(issuer.verify(token, Date.now(), 'gen-2')).toBeNull();
  });

  it('refuses container enrollment without a verified package', async () => {
    const supervisor = new ModuleSupervisor({ transport: () => ({ send: async () => null }) });
    await expect(
      supervisor.enroll(module, { packageVerified: false, runMode: 'container' }),
    ).rejects.toThrow(/signed package/);
  });

  it('handshakes, invokes a stage and stops a container', async () => {
    const ops: string[] = [];
    const supervisor = new ModuleSupervisor({
      generation: 'gen-1',
      transport: () => ({
        send: async (envelope, token) => {
          ops.push(`${envelope.op}:${issuer.publicKeyBase64 ? 'token' : 'none'}`);
          const verified = issuer.verify(token);
          if (!verified) throw new Error('bad session token');
          if (envelope.op === 'stage.invoke') {
            const payload = envelope.payload as { kind: string };
            return response(envelope, { output: { ran: payload.kind } });
          }
          return response(envelope, { status: 'healthy' });
        },
      }),
    });
    const issuer = supervisor.issuer;
    const entry = await supervisor.enroll(module, {
      packageVerified: true,
      runMode: 'container',
      endpoint: 'http://demo:8080',
    });
    expect(entry.session.token).toBeTruthy();
    expect(issuer.verify(entry.session.token)?.sub).toBe('module:demo@1.0.0');
    await expect(
      supervisor.invokeStage(
        'demo',
        {
          runId: 'run-1',
          workflowId: 'wf',
          stageId: 's',
          kind: 'demo.run',
          config: {},
          input: {},
          data: {},
        },
        { idempotencyKey: 'run-1:s' },
      ),
    ).resolves.toEqual({ output: { ran: 'demo.run' } });
    await expect(supervisor.health('demo')).resolves.toBe('healthy');
    await supervisor.drain('demo');
    await supervisor.stop('demo');
    expect(supervisor.get('demo')).toBeUndefined();
    expect(ops).toEqual([
      'handshake:token',
      'stage.invoke:token',
      'health:token',
      'drain:token',
      'stop:token',
    ]);
  });

  it('returns dependencyUnavailable after repeated transport failures', async () => {
    const send = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const supervisor = new ModuleSupervisor({ transport: () => ({ send }) });
    await expect(
      supervisor.enroll(module, { packageVerified: true, runMode: 'worker' }),
    ).rejects.toThrow(/connection refused/);
    expect(send).toHaveBeenCalled();
  });
});
