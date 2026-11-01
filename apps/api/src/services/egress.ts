/**
 * One egress client for outbound HTTP (Phase 18.5, hardened in Phase 21):
 * host allowlist re-checked per redirect, private/link-local/metadata address
 * rejection after DNS resolution, a default timeout and a streamed size cap.
 */
import { lookup as dnsLookup } from 'node:dns/promises';

import { Agent } from 'undici';

import { AppError, policyBlocked } from '@triageai/kernel';
import type { Database } from '@triageai/kernel';

import { writeAudit } from './audit.js';

export interface EgressRule {
  host: string;
  dataClass: 'public' | 'internal' | 'restricted' | 'secret';
}

interface EgressOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  lookup?: (host: string) => Promise<string[]>;
  /** Test seam: exercise redirects against a local fixture server. */
  pinAddress?: boolean;
}

export interface EgressContext {
  actor?: string | null;
  purpose: string;
  /** Per-call cap; defaults to the client cap (plugin downloads opt in higher). */
  maxBytes?: number;
}

const BLOCKED_V4 = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^198\.(1[89])\./,
  /^22[4-9]\./,
  /^23\d\./,
  /^24\d\./,
  /^25[0-5]\./,
];

/** Exported for tests and for the queue/tool adapters that reuse the rule. */
export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::1' || normalized === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  const mappedHex =
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized) ??
    /^(?:0{1,4}:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  let v4 = mapped?.[1] ?? normalized;
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1] as string, 16);
    const low = Number.parseInt(mappedHex[2] as string, 16);
    v4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return BLOCKED_V4.some((pattern) => pattern.test(v4));
}

export class EgressClient {
  private readonly rules = new Map<string, EgressRule>();
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxRedirects: number;
  private readonly lookup: (host: string) => Promise<string[]>;
  private readonly pinAddress: boolean;

  constructor(
    private readonly database: Database,
    rules: EgressRule[],
    options: EgressOptions = {},
  ) {
    for (const rule of rules) this.rules.set(rule.host.toLowerCase(), rule);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 5_000_000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.pinAddress = options.pinAddress ?? true;
    this.lookup =
      options.lookup ??
      (async (host) => (await dnsLookup(host, { all: true })).map((entry) => entry.address));
  }

  allows(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return [...this.rules.keys()].some(
        (allowed) => host === allowed || host.endsWith(`.${allowed}`),
      );
    } catch {
      return false;
    }
  }

  async fetch(url: string, init: RequestInit, context: EgressContext): Promise<Response> {
    let current = url;
    let method = init.method ?? 'GET';
    let body = init.body;
    const headers = new Headers(init.headers);
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      if (!this.allows(current)) {
        await this.deny(context, current, 'egress.denied', 'host is not allowlisted');
        throw policyBlocked(`egress to ${new URL(current).hostname} is not allowlisted`);
      }
      const host = new URL(current).hostname;
      let addresses: string[];
      try {
        addresses = await this.lookup(host);
      } catch {
        throw new AppError('egress.DNS_FAILED', `could not resolve ${host}`, undefined, 502, {
          category: 'dependency_unavailable',
          retryable: true,
        });
      }
      if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
        await this.deny(context, current, 'egress.private_blocked', 'private address');
        throw policyBlocked(`egress to ${host} resolves to a private or reserved address`);
      }
      const address = addresses[0] as string;
      // Pin the connection to the address that passed the private-range check;
      // a second DNS answer must not be able to rebind the socket (R22).
      const agent = this.pinAddress
        ? new Agent({
            connect: {
              lookup: (_hostname, options, callback) => {
                const family = address.includes(':') ? 6 : 4;
                if (options?.all) callback(null, [{ address, family }] as never);
                else callback(null, address, family);
              },
            },
          })
        : null;
      const signal =
        init.signal ??
        (typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(this.timeoutMs)
          : undefined);
      const requestInit = { ...init, method, body, headers, signal };
      let response: Response;
      try {
        response = await fetch(current, {
          ...requestInit,
          redirect: 'manual',
          ...(agent ? { dispatcher: agent } : {}),
        } as RequestInit & { dispatcher?: Agent });
      } catch (err) {
        await agent?.close().catch(() => undefined);
        throw err;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await agent?.close().catch(() => undefined);
        if (!location) return response;
        const next = new URL(location, current);
        const crossOrigin = next.origin !== new URL(current).origin;
        if (crossOrigin) {
          // Never forward caller credentials (or a body) to another host.
          headers.delete('authorization');
          headers.delete('cookie');
          headers.delete('proxy-authorization');
        }
        if (crossOrigin || [301, 302, 303].includes(response.status)) {
          method = 'GET';
          body = undefined;
          headers.delete('content-type');
          headers.delete('content-length');
        }
        headers.delete('host');
        current = next.toString();
        continue;
      }
      try {
        return await this.cap(response, context.maxBytes);
      } finally {
        await agent?.close().catch(() => undefined);
      }
    }
    throw new AppError('egress.TOO_MANY_REDIRECTS', 'too many redirects', undefined, 502, {
      category: 'dependency_unavailable',
      retryable: false,
    });
  }

  private async cap(response: Response, maxBytes?: number): Promise<Response> {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > (maxBytes ?? this.maxBytes)) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(
          'egress.TOO_LARGE',
          `response is larger than ${maxBytes ?? this.maxBytes} bytes`,
          undefined,
          413,
          { category: 'validation', retryable: false },
        );
      }
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private async deny(
    context: { actor?: string | null; purpose: string },
    url: string,
    action: string,
    reason: string,
  ): Promise<void> {
    await writeAudit(this.database, {
      actor: context.actor ?? null,
      action,
      subject: context.purpose,
      payload: { url, reason },
    });
  }
}
