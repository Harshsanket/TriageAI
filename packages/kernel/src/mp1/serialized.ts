/**
 * In-process MP1 transport with a `serialized` test mode (ADR-0054 §6): every
 * core call round-trips through JSON and both Zod envelope/payload validations,
 * so CI catches anything that only works because it never left the process.
 */
import { parseMp1Envelope, type Mp1Envelope, type Mp1Op } from '@triageai/contracts';
import { ulid } from 'ulid';

import { invalid } from '../errors.js';
import { mp1Request } from './broker.js';

export interface Mp1RoundTripOptions {
  moduleId: string;
  moduleVersion: string;
  op: Mp1Op;
  schema: string;
  payload: unknown;
  dataClass?: Mp1Envelope['dataClass'];
}

function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export async function mp1RoundTrip<T>(
  options: Mp1RoundTripOptions,
  execute: (payload: never) => Promise<T>,
): Promise<T> {
  const request = mp1Request({
    op: options.op,
    from: `module:${options.moduleId}@${options.moduleVersion}`,
    to: 'core',
    schema: options.schema,
    payload: options.payload,
    dataClass: options.dataClass,
  });
  const inbound = parseMp1Envelope(wire(request));
  if (!inbound.ok) throw invalid('serialized MP1 request is invalid', inbound.issues);

  const result = await execute(inbound.envelope.payload as never);

  const response: Mp1Envelope = {
    mp: '1.0',
    id: ulid(),
    kind: 'response',
    op: request.op,
    from: 'core',
    to: request.from,
    schema: 'mp1.response@1',
    correlationId: request.id,
    deadline: new Date(Date.now() + 30_000).toISOString(),
    dataClass: request.dataClass,
    payload: result ?? null,
  };
  const outbound = parseMp1Envelope(wire(response));
  if (!outbound.ok) throw invalid('serialized MP1 response is invalid', outbound.issues);
  return outbound.envelope.payload as T;
}

/** True when the process is asked to serialise in-process module calls. */
export function serializedTransportEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.TRIAGEAI_MODULE_TRANSPORT === 'serialized';
}
