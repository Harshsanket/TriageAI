import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { PostgresDatabase } from '@triageai/kernel';

import { EgressClient, isPrivateAddress } from '../src/services/egress.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

describe('egress private-range rules', () => {
  it('classifies loopback, private, link-local and metadata addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.2.3.4',
      '172.16.0.5',
      '192.168.1.10',
      '169.254.169.254',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:ffff:7f00:1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });
});

describeIfDb('egress client hardening (phase 21)', () => {
  let database: PostgresDatabase;
  let server: Server;
  let base = '';

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    server = createServer((request, response) => {
      if (request.url === '/cross-redirect') {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        response.writeHead(302, { location: `http://127.0.0.1:${port}/echo` });
        response.end();
        return;
      }
      if (request.url === '/echo') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              authorization: request.headers.authorization ?? null,
              cookie: request.headers.cookie ?? null,
              method: request.method,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        });
        return;
      }
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/private' });
        response.end();
        return;
      }
      if (request.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('x'.repeat(100));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await database.close();
  });

  it('re-checks each redirect hop and blocks a private destination', async () => {
    let calls = 0;
    const client = new EgressClient(
      database,
      [
        { host: 'localhost', dataClass: 'public' },
        { host: '127.0.0.1', dataClass: 'public' },
      ],
      {
        pinAddress: false,
        lookup: async () => {
          calls += 1;
          return calls === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
        },
      },
    );
    await expect(
      client.fetch(`${base}/redirect`, {}, { actor: 'test', purpose: 'redirect.fixture' }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
    const audit = await database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE subject = 'redirect.fixture' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit[0]?.action).toBe('egress.private_blocked');
  });

  it('strips credentials and the body on a cross-origin redirect (R21)', async () => {
    const client = new EgressClient(
      database,
      [
        { host: 'localhost', dataClass: 'public' },
        { host: '127.0.0.1', dataClass: 'public' },
      ],
      { pinAddress: false, lookup: async () => ['93.184.216.34'] },
    );
    const response = await client.fetch(
      `${base}/cross-redirect`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret', cookie: 'sid=1', 'content-type': 'text/plain' },
        body: 'payload',
      },
      { actor: 'test', purpose: 'redirect.credentials' },
    );
    expect(await response.json()).toEqual({
      authorization: null,
      cookie: null,
      method: 'GET',
      body: '',
    });
  });

  it('pins the connection to the vetted address (R22)', async () => {
    let hits = 0;
    const onRequest = () => {
      hits += 1;
    };
    server.on('request', onRequest);
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const client = new EgressClient(database, [{ host: 'localhost', dataClass: 'public' }], {
        timeoutMs: 300,
        lookup: async () => ['93.184.216.34'],
      });
      await expect(
        client.fetch(`http://localhost:${port}/rebind`, {}, { purpose: 'rebind.fixture' }),
      ).rejects.toBeTruthy();
      expect(hits).toBe(0);
    } finally {
      server.off('request', onRequest);
    }
  });

  it('caps a streamed response without a content-length header', async () => {
    const client = new EgressClient(database, [{ host: 'localhost', dataClass: 'public' }], {
      maxBytes: 10,
      pinAddress: false,
      lookup: async () => ['93.184.216.34'],
    });
    await expect(
      client.fetch(`${base}/large`, {}, { actor: 'test', purpose: 'size.fixture' }),
    ).rejects.toMatchObject({ code: 'egress.TOO_LARGE' });
  });

  it('refuses a host that is not allowlisted and audits it', async () => {
    const client = new EgressClient(database, [], { lookup: async () => ['93.184.216.34'] });
    await expect(
      client.fetch('https://example.com/', {}, { actor: 'test', purpose: 'allowlist.fixture' }),
    ).rejects.toMatchObject({ code: 'POLICY_BLOCKED' });
  });
});
