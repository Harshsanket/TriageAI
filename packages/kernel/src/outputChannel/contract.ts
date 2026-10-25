/**
 * OutputChannel contract suite (contract-testing.md §3). Every integration
 * adapter runs this unchanged: delivery, idempotency, rate-limit retry, and
 * (when supported) credential rotation. Tests use a local mock server — no
 * live provider credentials or network calls in CI.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, it } from 'vitest';

import type { DeliveryContext, OutputChannel } from '../types.js';

export interface ChannelContractFactoryOptions {
  tokens: string[];
}

export interface ChannelContractFactory {
  (
    baseUrl: string,
    options: ChannelContractFactoryOptions,
  ): Promise<{
    channel: OutputChannel;
    dispose?(): Promise<void>;
  }>;
}

export interface OutputChannelContractOptions {
  channel: string;
  supportsTokenRotation?: boolean;
  successBody?: Record<string, unknown>;
  /** Path prefix the adapter will append to the base URL. */
  successStatus?: number;
  retryStatus?: number;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface MockChannelServer {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Queue of scripted statuses; empty means success. */
  script: number[];
  close(): Promise<void>;
  readonly url: string;
}

export async function startMockChannelServer(
  successBody: Record<string, unknown> = { id: 'mock-1', number: 1, ok: true },
  successStatus = 200,
): Promise<MockChannelServer> {
  const requests: RecordedRequest[] = [];
  const script: number[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const status = script.shift() ?? successStatus;
      res.statusCode = status;
      if (status === 429) res.setHeader('retry-after', '0');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(status >= 400 ? { error: 'scripted failure' } : successBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    requests,
    script,
    url: baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

const context = (idempotencyKey?: string): DeliveryContext => ({
  runId: 'run-1',
  workflowId: 'integration.contract',
  stageId: 'deliver',
  orgId: null,
  ...(idempotencyKey ? { idempotencyKey } : {}),
});

export function outputChannelContractSuite(
  name: string,
  factory: ChannelContractFactory,
  options: OutputChannelContractOptions,
): void {
  it(`${name}: delivers a message and returns a stable ref`, async () => {
    const server = await startMockChannelServer(options.successBody, options.successStatus);
    const fixture = await factory(server.baseUrl, { tokens: ['token-a'] });
    try {
      const result = await fixture.channel.deliver(context('contract:one'), {
        channel: options.channel,
        title: 'Contract test',
        body: 'hello from the contract suite',
      });
      expect(result.channel).toBe(options.channel);
      expect(result.ref.length).toBeGreaterThan(0);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].body).toContain('hello from the contract suite');
    } finally {
      await fixture.dispose?.();
      await server.close();
    }
  });

  it(`${name}: deduplicates a repeated delivery idempotency key`, async () => {
    const server = await startMockChannelServer(options.successBody, options.successStatus);
    const fixture = await factory(server.baseUrl, { tokens: ['token-a'] });
    try {
      const intent = {
        channel: options.channel,
        body: 'deliver exactly once',
        idempotencyKey: 'contract:dedupe',
      };
      const first = await fixture.channel.deliver(context(), intent);
      const second = await fixture.channel.deliver(context(), intent);
      expect(first.deduped).not.toBe(true);
      expect(second.deduped).toBe(true);
      expect(server.requests).toHaveLength(1);
    } finally {
      await fixture.dispose?.();
      await server.close();
    }
  });

  it(`${name}: retries a rate-limited request and succeeds`, async () => {
    const server = await startMockChannelServer(options.successBody, options.successStatus);
    server.script.push(options.retryStatus ?? 429);
    const fixture = await factory(server.baseUrl, { tokens: ['token-a'] });
    try {
      const result = await fixture.channel.deliver(context('contract:retry'), {
        channel: options.channel,
        body: 'retry me',
      });
      expect(result.ref.length).toBeGreaterThan(0);
      expect(server.requests).toHaveLength(2);
    } finally {
      await fixture.dispose?.();
      await server.close();
    }
  });

  if (options.supportsTokenRotation) {
    it(`${name}: rotates credentials after an unauthorized response`, async () => {
      const server = await startMockChannelServer(options.successBody, options.successStatus);
      server.script.push(401);
      const fixture = await factory(server.baseUrl, { tokens: ['stale-token', 'fresh-token'] });
      try {
        const result = await fixture.channel.deliver(context('contract:rotation'), {
          channel: options.channel,
          body: 'rotate me',
        });
        expect(result.ref.length).toBeGreaterThan(0);
        expect(server.requests).toHaveLength(2);
        expect(JSON.stringify(server.requests[1].headers)).toContain('fresh-token');
      } finally {
        await fixture.dispose?.();
        await server.close();
      }
    });
  }
}
