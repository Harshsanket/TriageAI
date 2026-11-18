/**
 * Internal helpers shared by the importers. Not exported from the package
 * entry point: the public surface is descriptor types plus the three importers.
 */
import { z } from 'zod';
import type { ZodType } from 'zod';

import { ConnectorError } from './types.js';

/** Mirrors the kernel tool-name grammar (`packages/kernel/src/tools/registry.ts`). */
export const TOOL_NAME = /^[a-z][a-z0-9_]*\.[a-z]+(_[a-z0-9_]+)?$/;

const VERB_ALIASES: Record<string, string> = {
  get: 'get',
  read: 'get',
  fetch: 'get',
  list: 'list',
  search: 'search',
  find: 'search',
  create: 'create',
  add: 'create',
  new: 'create',
  update: 'update',
  patch: 'update',
  edit: 'update',
  upsert: 'update',
  delete: 'delete',
  remove: 'delete',
  send: 'send',
  run: 'run',
  execute: 'run',
};

const READ_VERBS = new Set(['get', 'list', 'search']);

export function splitWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeNamespace(value: string | undefined, fallback: string): string {
  const raw = value ?? fallback;
  if (typeof raw !== 'string') {
    throw new ConnectorError('connector.INVALID_NAMESPACE', 'namespace must be a string');
  }
  const namespace = raw.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(namespace) || namespace.endsWith('_')) {
    throw new ConnectorError(
      'connector.INVALID_NAMESPACE',
      `namespace "${value ?? fallback}" must be lowercase snake case, 1–32 characters`,
    );
  }
  return namespace;
}

function toolName(namespace: string, verb: string, words: string[], fallback: string): string {
  const object =
    words
      .join('_')
      .replace(/[^a-z0-9_]/g, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || fallback;
  const prefix = `${namespace}.${verb}_`;
  const available = 64 - prefix.length;
  const trimmed = object.slice(0, Math.max(1, available)).replace(/_+$/g, '') || fallback;
  const name = `${prefix}${trimmed}`;
  if (!TOOL_NAME.test(name)) {
    throw new ConnectorError(
      'connector.INVALID_NAME',
      `derived tool name "${name}" does not follow <namespace>.<verb>_<object>`,
    );
  }
  return name;
}

/** Fixed mapping: query prefixes may only use read verbs; mutation prefixes may
 * only use write/run verbs. Unknown prefixes become `get_`/`run_` rather than
 * letting a query masquerade as a write. */
export function graphqlToolName(
  namespace: string,
  operationName: string,
  kind: 'query' | 'mutation',
): string {
  const words = splitWords(operationName);
  if (words.length === 0) {
    throw new ConnectorError(
      'connector.INVALID_NAME',
      'GraphQL operation names must contain at least one letter or digit',
    );
  }
  const canonical = VERB_ALIASES[words[0] as string];
  if (kind === 'query') {
    if (canonical && READ_VERBS.has(canonical)) {
      return toolName(namespace, canonical, words.slice(1), 'data');
    }
    return toolName(namespace, 'get', words, 'data');
  }
  if (canonical && !READ_VERBS.has(canonical)) {
    return toolName(namespace, canonical, words.slice(1), 'data');
  }
  return toolName(namespace, 'run', words, 'data');
}

export function sqlToolName(namespace: string, verb: string, queryName: string): string {
  const words = splitWords(queryName);
  const canonical = VERB_ALIASES[words[0] as string];
  const rest = canonical === verb ? words.slice(1) : words;
  return toolName(namespace, verb, rest, 'rows');
}

export function describeConnector(provided: string | undefined, fallback: string): string {
  const text = provided?.trim();
  if (text && text.length >= 10) return text.slice(0, 400);
  return fallback.slice(0, 400);
}

export function checkedTimeout(value: number | undefined, fallback: number, label: string): number {
  return checkedInteger(value, fallback, 1, 120_000, `${label} timeoutMs`);
}

export function checkedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new ConnectorError(
      'connector.INVALID_LIMIT',
      `${label} must be an integer between ${min} and ${max}`,
    );
  }
  return resolved;
}

export function assertSchema(value: unknown, label: string): ZodType {
  if (typeof value !== 'object' || value === null) {
    throw new ConnectorError('connector.SCHEMA_REQUIRED', `${label} must be a Zod schema`);
  }
  const candidate = value as { parse?: unknown; safeParse?: unknown };
  if (typeof candidate.parse !== 'function' || typeof candidate.safeParse !== 'function') {
    throw new ConnectorError('connector.SCHEMA_REQUIRED', `${label} must be a Zod schema`);
  }
  return value as ZodType;
}

function zodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

export function parseInput(schema: ZodType, value: unknown, label: string): unknown {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConnectorError(
        'connector.INPUT_INVALID',
        `${label} input does not match its schema`,
        {
          details: zodIssues(error),
        },
      );
    }
    throw error;
  }
}

export function parseOutput(schema: ZodType, value: unknown, label: string): unknown {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ConnectorError(
        'connector.OUTPUT_INVALID',
        `${label} output does not match its schema`,
        { details: zodIssues(error) },
      );
    }
    throw error;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

/** Keys that must never be used as input paths, columns or variable names. */
export const RESERVED_INPUT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function assertInputPath(path: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path)) {
    throw new ConnectorError(
      'connector.INVALID_PARAMETER',
      `${label} parameter path "${path}" must be a dotted input field path`,
    );
  }
  for (const segment of path.split('.')) {
    if (RESERVED_INPUT_KEYS.has(segment)) {
      throw new ConnectorError(
        'connector.INVALID_PARAMETER',
        `${label} parameter path "${path}" may not use "${segment}"`,
      );
    }
  }
}

export function normalizeHeaders(
  value: Record<string, string> | undefined,
  label: string,
): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new ConnectorError('connector.INVALID_HEADERS', `${label} headers must be an object`);
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]+$/.test(key)) {
      throw new ConnectorError(
        'connector.INVALID_HEADERS',
        `${label} header name "${key}" is invalid`,
      );
    }
    if (typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) {
      throw new ConnectorError(
        'connector.INVALID_HEADERS',
        `${label} header "${key}" must be a single-line string`,
      );
    }
    headers[key.toLowerCase()] = headerValue;
  }
  return headers;
}

export function normalizeScopes(
  scopes: string[] | undefined,
  fallback: string[],
  label: string,
): string[] {
  const values = scopes ?? fallback;
  if (!Array.isArray(values) || values.length === 0) {
    throw new ConnectorError(
      'connector.INVALID_SCOPES',
      `${label} must declare at least one scope`,
    );
  }
  for (const scope of values) {
    if (typeof scope !== 'string' || !/^[A-Za-z0-9:_*.-]{1,100}$/.test(scope)) {
      throw new ConnectorError(
        'connector.INVALID_SCOPES',
        `${label} has an invalid scope "${scope}"`,
      );
    }
  }
  return [...new Set(values)];
}

export function normalizeExamples(examples: unknown[] | undefined, label: string): unknown[] {
  const values = examples ?? [{}];
  if (!Array.isArray(values) || values.length < 1 || values.length > 2) {
    throw new ConnectorError(
      'connector.INVALID_EXAMPLES',
      `${label} must declare one or two example calls`,
    );
  }
  return values;
}

export function assertUniqueNames(names: string[], label: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new ConnectorError(
        'connector.DUPLICATE_TOOL',
        `${label} produces the tool name "${name}" more than once; rename one entry`,
      );
    }
    seen.add(name);
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  );
}

export function parseHttpUrl(
  value: string,
  label: string,
  options: { secure?: boolean; code?: string } = {},
): URL {
  const code = options.code ?? 'connector.INVALID_ENDPOINT';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError(code, `${label} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConnectorError(code, `${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new ConnectorError(code, `${label} must not embed credentials`);
  }
  if (options.secure && url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new ConnectorError(
      code,
      `${label} must use https (plain http is allowed only on loopback)`,
    );
  }
  return url;
}
