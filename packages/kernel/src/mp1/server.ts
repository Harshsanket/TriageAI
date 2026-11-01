/**
 * Minimal MP1 HTTP server for container modules (ADR-0055 §2/§4). It verifies
 * the bearer session token and (when a core public key is configured) the
 * core's signature, validates both directions, and dispatches the module ops.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  parseMp1Envelope,
  type ErrorEnvelope,
  type Mp1Envelope,
  type Mp1Op,
} from '@triageai/contracts';
import { ulid } from 'ulid';

import { AppError, invalid, internal } from '../errors.js';
import { verifyCoreSignature } from './signer.js';
import { ReplayCache } from './replay.js';
import { verifySessionToken } from './sessionToken.js';

export type Mp1ServerHandler = (payload: unknown, envelope: Mp1Envelope) => Promise<unknown>;

export interface Mp1ServerOptions {
  moduleId: string;
  version: string;
  port: number;
  host?: string;
  handlers: Partial<Record<Mp1Op, Mp1ServerHandler>>;
  /** Base64 SPKI ed25519 key used to verify the core's `coreSig`. */
  corePublicKeyBase64?: string;
  /** Stage-A session token verification (containers always enable this). */
  sessionPublicKeyBase64?: string;
  sessionGeneration?: string;
  requireSession?: boolean;
  maxBytes?: number;
  now?: () => number;
  onStop?: () => void;
}

export interface Mp1Server {
  port: number;
  close(): Promise<void>;
}

const PRINCIPAL = /^module:([a-z0-9-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function errorEnvelope(error: AppError, correlationId: string): ErrorEnvelope {
  return error.toEnvelope(correlationId);
}

function response(
  request: Mp1Envelope,
  payload: unknown,
  options: { moduleId: string; version: string; now: () => number },
  error?: ErrorEnvelope,
): Mp1Envelope {
  return {
    mp: '1.0',
    id: ulid(),
    kind: 'response',
    op: request.op,
    from: `module:${options.moduleId}@${options.version}`,
    to: request.from,
    schema: 'mp1.response@1',
    correlationId: request.id,
    deadline: new Date(options.now() + 30_000).toISOString(),
    dataClass: request.dataClass,
    payload: error ? null : payload,
    ...(error ? { error } : {}),
  };
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(invalid('MP1 envelope exceeds 1 MiB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export async function startMp1HttpServer(options: Mp1ServerOptions): Promise<Mp1Server> {
  const now = options.now ?? Date.now;
  const replay = new ReplayCache();
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const stopRef: { close?: () => void } = {};

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/mp1') {
      res.writeHead(404).end();
      return;
    }
    try {
      if (options.requireSession) {
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        const claims = options.sessionPublicKeyBase64
          ? verifySessionToken(
              bearer,
              options.sessionPublicKeyBase64,
              options.sessionGeneration,
              now(),
            )
          : null;
        if (!claims) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: errorEnvelope(
                new AppError(
                  'MP1_UNAUTHORIZED',
                  'invalid or expired session token',
                  undefined,
                  401,
                ),
                'unknown',
              ),
            }),
          );
          return;
        }
      }
      const raw = JSON.parse((await readBody(req, maxBytes)).toString('utf8')) as unknown;
      const parsed = parseMp1Envelope(raw);
      if (!parsed.ok) throw invalid('invalid MP1 envelope', parsed.issues);
      const envelope = parsed.envelope;
      if (
        options.corePublicKeyBase64 &&
        !verifyCoreSignature(envelope, options.corePublicKeyBase64)
      ) {
        throw new AppError('MP1_SIGNATURE_INVALID', 'coreSig verification failed', undefined, 403);
      }
      const deadline = Date.parse(envelope.deadline);
      if (!Number.isFinite(deadline) || deadline < now()) {
        throw new AppError(
          'MP1_DEADLINE_EXPIRED',
          'the message deadline has passed',
          undefined,
          408,
        );
      }
      if (!replay.check(envelope, now())) {
        throw new AppError('MP1_REPLAY', 'the message id was already seen', undefined, 409);
      }
      const principal = PRINCIPAL.exec(envelope.from);
      if (envelope.from !== 'core' && !principal) {
        throw new AppError('MP1_UNAUTHORIZED', 'unknown sender principal', undefined, 401);
      }
      const handler = options.handlers[envelope.op];
      if (!handler) throw invalid(`unsupported MP1 op ${envelope.op}`);
      const payload = await handler(envelope.payload, envelope);
      const body = response(envelope, payload, {
        moduleId: options.moduleId,
        version: options.version,
        now,
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (envelope.op === 'stop') {
        setTimeout(() => stopRef.close?.(), 50);
      }
    } catch (err) {
      const appError = err instanceof AppError ? err : internal((err as Error).message);
      const body = response(
        {
          mp: '1.0',
          id: 'unknown',
          kind: 'request',
          op: 'health',
          from: 'core',
          to: 'core',
          schema: 'mp1.health@1',
          deadline: new Date().toISOString(),
          dataClass: 'internal',
          payload: {},
        },
        null,
        { moduleId: options.moduleId, version: options.version, now },
        errorEnvelope(appError, 'unknown'),
      );
      res
        .writeHead(appError.statusCode, { 'content-type': 'application/json' })
        .end(JSON.stringify(body));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  stopRef.close = () => {
    server.close();
    options.onStop?.();
  };
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
