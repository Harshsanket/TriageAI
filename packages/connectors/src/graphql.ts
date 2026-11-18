/**
 * GraphQL connector importer (Phase 15.T7): named queries and mutations become
 * tool descriptors. Queries are enabled only when their contract is complete;
 * mutations are always high-risk writes with `undo: none` and start disabled.
 *
 * Execution is injected: the host passes `EgressClient.fetch` as `request`, so
 * the library never performs a raw network call by itself.
 */
import { z } from 'zod';
import type { ZodType } from 'zod';

import {
  assertInputPath,
  assertSchema,
  assertUniqueNames,
  checkedTimeout,
  describeConnector,
  graphqlToolName,
  isPlainObject,
  normalizeExamples,
  normalizeHeaders,
  normalizeNamespace,
  normalizeScopes,
  parseHttpUrl,
  parseInput,
  parseOutput,
  readPath,
} from './helpers.js';
import { fetchWithTimeout } from './http.js';
import { ConnectorError } from './types.js';
import type { ConnectorExecuteOptions, ConnectorFetch, ConnectorToolDescriptor } from './types.js';

export interface GraphqlOperation {
  /** Operation name from the document; used to derive the tool name. */
  name: string;
  kind: 'query' | 'mutation';
  document: string;
  description?: string;
  /**
   * GraphQL variable name -> tool input field (dot paths allowed). When omitted
   * every input field becomes a variable with the same name.
   */
  variables?: Record<string, string>;
  headers?: Record<string, string>;
  /**
   * Required for a complete tool. A missing schema yields a permissive schema
   * and `complete: false`, so the imported operation stays disabled.
   */
  inputSchema?: ZodType;
  /** Validated against the GraphQL `data` object. */
  outputSchema?: ZodType;
  scopes?: string[];
  timeoutMs?: number;
  examples?: unknown[];
}

export interface GraphqlImportOptions {
  endpoint: string;
  /** One namespace segment, e.g. `crm` or `graphql` (default). */
  namespace?: string;
  headers?: Record<string, string>;
  operations: GraphqlOperation[];
  /** Injected fetch; defaults to global fetch for tests and local callers. */
  request?: ConnectorFetch;
  timeoutMs?: number;
  /** Mutations start disabled; set only after an admin completes the contract. */
  allowWrites?: boolean;
}

export interface ImportedGraphqlTool extends ConnectorToolDescriptor {
  kind: 'graphql';
  endpoint: string;
  operation: GraphqlOperation;
  execute(input: unknown, options?: ConnectorExecuteOptions): Promise<unknown>;
}

const GraphqlResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string().max(500).optional(),
        path: z.array(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .max(50)
    .optional(),
});

function documentKind(document: string): 'query' | 'mutation' {
  let index = 0;
  for (;;) {
    const rest = document.slice(index);
    const whitespace = /^\s+/.exec(rest);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    if (rest.startsWith('#')) {
      const newline = rest.indexOf('\n');
      index += newline < 0 ? rest.length : newline + 1;
      continue;
    }
    break;
  }
  const rest = document.slice(index);
  if (rest.startsWith('{')) return 'query';
  const match = /^(query|mutation|subscription)\b/.exec(rest);
  if (!match) {
    throw new ConnectorError(
      'connector.GRAPHQL_DOCUMENT_INVALID',
      'GraphQL documents must start with a query/mutation definition (or a shorthand `{` query)',
    );
  }
  if (match[1] === 'subscription') {
    throw new ConnectorError(
      'connector.GRAPHQL_DOCUMENT_INVALID',
      'GraphQL subscriptions are not supported by the one-shot connector importer',
    );
  }
  return match[1] as 'query' | 'mutation';
}

function operationNameFor(document: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\s)(?:query|mutation)\\s+${escaped}\\b`).test(document)
    ? name
    : undefined;
}

function buildVariables(
  input: unknown,
  mapping: Record<string, string> | undefined,
  label: string,
): Record<string, unknown> {
  if (!isPlainObject(input)) {
    throw new ConnectorError('connector.INPUT_INVALID', `${label} input must be an object`);
  }
  if (!mapping) return { ...input };
  const variables: Record<string, unknown> = {};
  for (const [variable, path] of Object.entries(mapping)) {
    const value = readPath(input, path);
    if (value !== undefined) variables[variable] = value;
  }
  return variables;
}

function validateOperation(operation: GraphqlOperation, label: string): void {
  if (typeof operation.name !== 'string' || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(operation.name)) {
    throw new ConnectorError(
      'connector.GRAPHQL_DOCUMENT_INVALID',
      `${label} name "${operation.name}" is not a GraphQL operation name`,
    );
  }
  if (typeof operation.document !== 'string' || !operation.document.trim()) {
    throw new ConnectorError('connector.GRAPHQL_DOCUMENT_INVALID', `${label} needs a document`);
  }
  if (operation.document.includes('${')) {
    throw new ConnectorError(
      'connector.GRAPHQL_TEMPLATE_INTERPOLATION',
      `${label} document must not use string interpolation; pass values as GraphQL variables`,
    );
  }
  const kind = documentKind(operation.document);
  if (kind !== operation.kind) {
    throw new ConnectorError(
      'connector.GRAPHQL_KIND_MISMATCH',
      `${label} is declared as a ${operation.kind} but its document is a ${kind}`,
    );
  }
  const named = /^(?:query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(
    operation.document.trimStart(),
  );
  if (named && named[1] !== operation.name) {
    throw new ConnectorError(
      'connector.GRAPHQL_NAME_MISMATCH',
      `${label} does not match the document operation "${named[1]}"`,
    );
  }
  if (operation.variables) {
    for (const [variable, path] of Object.entries(operation.variables)) {
      if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(variable)) {
        throw new ConnectorError(
          'connector.GRAPHQL_DOCUMENT_INVALID',
          `${label} variable "${variable}" is not a GraphQL variable name`,
        );
      }
      assertInputPath(path, `${label} variable mapping "${variable}"`);
    }
  }
}

export function importGraphqlTools(options: GraphqlImportOptions): ImportedGraphqlTool[] {
  const namespace = normalizeNamespace(options.namespace, 'graphql');
  const endpoint = parseHttpUrl(options.endpoint, 'GraphQL endpoint');
  const staticHeaders = normalizeHeaders(options.headers, 'GraphQL');
  const request = options.request ?? globalThis.fetch;
  const defaultTimeout = checkedTimeout(options.timeoutMs, 30_000, 'GraphQL');
  const allowWrites = options.allowWrites === true;
  if (!Array.isArray(options.operations)) {
    throw new ConnectorError(
      'connector.OPERATIONS_INVALID',
      'GraphQL import operations must be an array',
    );
  }
  const tools: ImportedGraphqlTool[] = [];

  for (const operation of options.operations) {
    if (!operation || typeof operation !== 'object') {
      throw new ConnectorError(
        'connector.OPERATIONS_INVALID',
        'every GraphQL import operation must be an object',
      );
    }
    const label = `GraphQL operation "${operation.name}"`;
    validateOperation(operation, label);

    const suppliedInput =
      operation.inputSchema === undefined
        ? undefined
        : assertSchema(operation.inputSchema, `${label} inputSchema`);
    const suppliedOutput =
      operation.outputSchema === undefined
        ? undefined
        : assertSchema(operation.outputSchema, `${label} outputSchema`);
    const complete = suppliedInput !== undefined && suppliedOutput !== undefined;
    const inputSchema = suppliedInput ?? z.record(z.string(), z.unknown());
    const outputSchema = suppliedOutput ?? z.unknown();
    const timeoutMs = checkedTimeout(operation.timeoutMs, defaultTimeout, label);
    const name = graphqlToolName(namespace, operation.name, operation.kind);
    const headers = normalizeHeaders(
      { ...staticHeaders, ...normalizeHeaders(operation.headers, label) },
      label,
    );
    const description = describeConnector(
      operation.description,
      `GraphQL ${operation.kind} "${operation.name}" on ${endpoint.hostname}`,
    );

    const execute = async (
      rawInput: unknown,
      execOptions: ConnectorExecuteOptions = {},
    ): Promise<unknown> => {
      if (!complete) {
        throw new ConnectorError(
          'connector.CONTRACT_INCOMPLETE',
          `${label} is missing an input or output schema; complete the tool contract before enabling it`,
        );
      }
      if (operation.kind === 'mutation' && !allowWrites) {
        throw new ConnectorError(
          'connector.GRAPHQL_WRITES_DISABLED',
          `${label} is a mutation and writes are disabled for this import`,
        );
      }
      const input = parseInput(inputSchema, rawInput, label);
      const variables = buildVariables(input, operation.variables, label);
      const document = operation.document.trim();
      const body: Record<string, unknown> = { query: document, variables };
      const operationName = operationNameFor(document, operation.name);
      if (operationName) body.operationName = operationName;

      const response = await fetchWithTimeout({
        request,
        url: endpoint.toString(),
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
          body: JSON.stringify(body),
        },
        timeoutMs,
        ...(execOptions.signal ? { signal: execOptions.signal } : {}),
        codePrefix: 'connector.GRAPHQL',
        label,
      });

      const text = await response.text();
      if (!response.ok) {
        throw new ConnectorError(
          'connector.GRAPHQL_HTTP_ERROR',
          `${label} returned HTTP ${response.status}`,
          {
            retryable: response.status === 429 || response.status >= 500,
            details: { status: response.status },
          },
        );
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ConnectorError(
          'connector.GRAPHQL_RESPONSE_INVALID',
          `${label} returned a non-JSON response`,
        );
      }
      const parsed = GraphqlResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ConnectorError(
          'connector.GRAPHQL_RESPONSE_INVALID',
          `${label} returned an invalid GraphQL response`,
        );
      }
      if (parsed.data.errors?.length) {
        const messages = parsed.data.errors
          .map((error) => (error.message ?? 'unknown').slice(0, 300))
          .slice(0, 5);
        throw new ConnectorError(
          'connector.GRAPHQL_ERRORS',
          `${label} returned ${parsed.data.errors.length} GraphQL error(s): ${messages.join('; ')}`,
          { details: { messages } },
        );
      }
      if (parsed.data.data === undefined || parsed.data.data === null) {
        throw new ConnectorError('connector.GRAPHQL_RESPONSE_INVALID', `${label} returned no data`);
      }
      return parseOutput(outputSchema, parsed.data.data, label);
    };

    tools.push({
      kind: 'graphql',
      endpoint: endpoint.toString(),
      operation,
      name,
      version: '0.0.0',
      owner: `connector:${namespace}`,
      description,
      examples: normalizeExamples(operation.examples, label),
      inputSchema,
      outputSchema,
      access: operation.kind === 'query' ? 'read' : 'write',
      risk: operation.kind === 'query' ? 'low' : 'high',
      undo: operation.kind === 'query' ? 'free' : 'none',
      enabled: operation.kind === 'query' ? complete : complete && allowWrites,
      complete,
      idempotent: operation.kind === 'query',
      scopes: normalizeScopes(
        operation.scopes,
        [operation.kind === 'query' ? 'connector:read' : 'connector:write'],
        label,
      ),
      timeoutMs,
      allowedHosts: [endpoint.hostname],
      execute,
    });
  }

  assertUniqueNames(
    tools.map((tool) => tool.name),
    'this GraphQL import',
  );
  return tools;
}
