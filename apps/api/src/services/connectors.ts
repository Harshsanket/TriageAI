/**
 * Generic connector registry (Phase 15.T7): GraphQL and named-SQL connections
 * live in `settings['connector.connections']`, imported operations are stored
 * disabled and only an admin completes their contract before registration.
 *
 * Imported tools are host registrations (like MCP): every network call goes
 * through the host `EgressClient`, every SQL read uses the operator-created
 * read-only DSN, writes stay high risk with `undo: none` and the approval
 * pipeline, and secret values never leave the encrypted store.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { z } from 'zod';
import type { ZodType } from 'zod';

import type { Kernel, ToolDefinition, ToolAccess } from '@triageai/kernel';
import {
  classifySend,
  conflict,
  invalid,
  notFound,
  policyBlocked,
  validateToolDefinition,
} from '@triageai/kernel';
import { detect, maskPii } from '@triageai/rag';
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  importGraphqlTools,
  importSqlTools,
  isTokenExpired,
  PostgresSqlRunner,
  refreshToken,
  sqlDialectSupport,
  TokenSetSchema,
  validateNonce,
  validateState,
} from '@triageai/connectors';
import type {
  ConnectorFetch,
  GraphqlOperation,
  SqlDialect,
  SqlQuery,
  SqlRunner,
  TokenSet,
} from '@triageai/connectors';

import { writeAudit } from './audit.js';
import { EgressClient } from './egress.js';

export const CONNECTOR_CONNECTIONS_KEY = 'connector.connections';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const NAMESPACE = /^[a-z][a-z0-9_]{0,31}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const JSON_SCHEMA = z.record(z.string(), z.unknown());

export type ConnectorKind = 'graphql' | 'sql';
export type ConnectorStatus = 'draft' | 'ready' | 'needs_reauth' | 'error';

/** Decrypt-by-name seam; `SecretStore` implements it (Phase 11). */
export interface ConnectorSecretReader {
  get(name: string): Promise<string | null>;
  set?(name: string, value: string, actor: string): Promise<void>;
  delete?(name: string, actor: string): Promise<boolean>;
}

/**
 * The routes set this once per app; imported tool handlers resolve secrets at
 * call time (not at registration) so boot order and soft reloads do not matter.
 */
let secretReader: ConnectorSecretReader | null = null;

export function setConnectorSecretReader(reader: ConnectorSecretReader | null): void {
  secretReader = reader;
}

export interface StoredGraphqlOperation {
  name: string;
  kind: 'query' | 'mutation';
  document: string;
  description?: string;
  variables?: Record<string, string>;
  headers?: Record<string, string>;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  scopes?: string[];
  timeoutMs?: number;
  examples?: unknown[];
}

export interface StoredSqlQuery {
  name: string;
  verb: SqlQuery['verb'];
  sql: string;
  readOnly?: boolean;
  params?: string[];
  columns?: string[];
  description?: string;
  scopes?: string[];
  timeoutMs?: number;
  maxRows?: number;
  examples?: unknown[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface StoredConnectorTool {
  /** Kernel tool name produced by the importer. */
  name: string;
  description: string;
  access: ToolAccess;
  risk: 'low' | 'high';
  undo: 'free' | 'compensable' | 'none';
  idempotent: boolean;
  scopes: string[];
  timeoutMs: number;
  enabled: boolean;
  completed: boolean;
}

export interface ConnectorSecrets {
  /** Bearer API-key secret name. */
  apiKey?: string;
  /** Custom header auth: header name + secret name. */
  header?: { name: string; secret: string };
  /** Read-only Postgres DSN secret name (required for read tools). */
  readOnlyDsn?: string;
  /** Read/write Postgres DSN secret name (required for writes). */
  dsn?: string;
  /** OAuth client secret name. */
  clientSecret?: string;
}

export interface ConnectorOAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  successRedirect?: string;
}

export interface ConnectorSyncTarget {
  enabled: boolean;
  /** Completed read tool that returns the synced rows. */
  tool: string;
  managedKey: string;
  title: string;
  sensitivity?: 'public' | 'internal' | 'restricted' | 'secret';
  audience?: 'public' | 'operator';
  limit?: number;
  /** Input field that receives the saved watermark. */
  sinceField?: string;
}

export interface ConnectorConnection {
  id: string;
  name: string;
  kind: ConnectorKind;
  namespace: string;
  endpoint: string | null;
  dialect: SqlDialect | null;
  allowHost: boolean;
  egressHosts: string[];
  defaultSensitivity: 'public' | 'internal' | 'restricted' | 'secret';
  allowWrites: boolean;
  secrets: ConnectorSecrets;
  oauth: ConnectorOAuthConfig | null;
  status: ConnectorStatus;
  operations: StoredGraphqlOperation[];
  queries: StoredSqlQuery[];
  completedTools: StoredConnectorTool[];
  sync: ConnectorSyncTarget | null;
  createdAt: string;
  updatedAt: string;
  importedAt: string | null;
  lastError: string | null;
}

export interface ConnectorConnectionView {
  id: string;
  name: string;
  kind: ConnectorKind;
  namespace: string;
  endpoint: string | null;
  dialect: SqlDialect | null;
  allowHost: boolean;
  egressHosts: string[];
  defaultSensitivity: ConnectorConnection['defaultSensitivity'];
  allowWrites: boolean;
  /** Secret names only; values never leave the server. */
  secretNames: ConnectorSecrets;
  oauth: ConnectorOAuthConfig | null;
  status: ConnectorStatus;
  tools: StoredConnectorTool[];
  sync: ConnectorSyncTarget | null;
  createdAt: string;
  updatedAt: string;
  importedAt: string | null;
  lastError: string | null;
}

const GraphqlOperationSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: z.enum(['query', 'mutation']),
    document: z.string().trim().min(1).max(20_000),
    description: z.string().trim().max(400).optional(),
    variables: z.record(z.string(), z.string().max(200)).optional(),
    headers: z.record(z.string().max(100), z.string().max(2_000)).optional(),
    inputSchema: JSON_SCHEMA.optional(),
    outputSchema: JSON_SCHEMA.optional(),
    scopes: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
    examples: z.array(z.unknown()).min(1).max(2).optional(),
  })
  .strict();

const SqlQuerySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    verb: z.enum(['get', 'list', 'search', 'create', 'update', 'delete', 'send', 'run']),
    sql: z.string().trim().min(1).max(20_000),
    readOnly: z.boolean().optional(),
    params: z.array(z.string().max(200)).max(50).optional(),
    columns: z.array(z.string().max(100)).max(200).optional(),
    description: z.string().trim().max(400).optional(),
    scopes: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
    maxRows: z.number().int().min(1).max(10_000).optional(),
    examples: z.array(z.unknown()).min(1).max(2).optional(),
    inputSchema: JSON_SCHEMA,
    outputSchema: JSON_SCHEMA,
  })
  .strict();

const SecretsSchema = z
  .object({
    apiKey: z.string().regex(SECRET_NAME).optional(),
    header: z
      .object({
        name: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
        secret: z.string().regex(SECRET_NAME),
      })
      .strict()
      .optional(),
    readOnlyDsn: z.string().regex(SECRET_NAME).optional(),
    dsn: z.string().regex(SECRET_NAME).optional(),
    clientSecret: z.string().regex(SECRET_NAME).optional(),
  })
  .strict();

const OAuthSchema = z
  .object({
    authorizationEndpoint: z.string().url(),
    tokenEndpoint: z.string().url(),
    clientId: z.string().trim().min(1).max(500),
    redirectUri: z.string().url(),
    scopes: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
    successRedirect: z
      .string()
      .trim()
      .regex(/^\/[^/]/, 'successRedirect must be a path starting with /')
      .max(300)
      .optional(),
  })
  .strict();

const SyncSchema = z
  .object({
    enabled: z.boolean().default(false),
    tool: z.string().trim().min(3).max(64),
    managedKey: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(300),
    sensitivity: z.enum(['public', 'internal', 'restricted', 'secret']).optional(),
    audience: z.enum(['public', 'operator']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    sinceField: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
  })
  .strict();

export const ConnectorConnectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['graphql', 'sql']),
    namespace: z.string().trim().regex(NAMESPACE).optional(),
    endpoint: z.string().url().optional(),
    dialect: z.enum(['postgres', 'mysql', 'sqlite', 'sqlserver']).optional(),
    allowHost: z.boolean().default(false),
    egressHosts: z.array(z.string().trim().regex(HOSTNAME)).max(20).default([]),
    defaultSensitivity: z.enum(['public', 'internal', 'restricted', 'secret']).default('internal'),
    allowWrites: z.boolean().default(false),
    secrets: SecretsSchema.optional(),
    oauth: OAuthSchema.optional(),
    operations: z.array(GraphqlOperationSchema).max(100).optional(),
    queries: z.array(SqlQuerySchema).max(100).optional(),
    sync: SyncSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'graphql' && !value.endpoint) {
      ctx.addIssue({
        code: 'custom',
        message: 'endpoint is required for GraphQL',
        path: ['endpoint'],
      });
    }
    if (value.kind === 'sql' && !value.dialect) {
      ctx.addIssue({ code: 'custom', message: 'dialect is required for SQL', path: ['dialect'] });
    }
    if (value.kind === 'graphql' && value.queries?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'queries are only valid for SQL',
        path: ['queries'],
      });
    }
    if (value.kind === 'sql' && value.operations?.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'operations are only valid for GraphQL',
        path: ['operations'],
      });
    }
  });

export type ConnectorConnectionInput = z.infer<typeof ConnectorConnectionInputSchema>;

export const ConnectorUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    allowHost: z.boolean().optional(),
    egressHosts: z.array(z.string().trim().regex(HOSTNAME)).max(20).optional(),
    defaultSensitivity: z.enum(['public', 'internal', 'restricted', 'secret']).optional(),
    allowWrites: z.boolean().optional(),
    secrets: SecretsSchema.optional(),
    oauth: OAuthSchema.nullable().optional(),
    operations: z.array(GraphqlOperationSchema).max(100).optional(),
    queries: z.array(SqlQuerySchema).max(100).optional(),
    sync: SyncSchema.nullable().optional(),
  })
  .strict();

export const ConnectorImportSchema = z
  .object({
    operations: z.array(GraphqlOperationSchema).max(100).optional(),
    queries: z.array(SqlQuerySchema).max(100).optional(),
  })
  .strict();

const ToolContractSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    description: z.string().trim().min(10).max(400).optional(),
    scopes: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
    /** Writes are never enabled implicitly. */
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(1).max(120_000).optional(),
    inputSchema: JSON_SCHEMA.optional(),
    outputSchema: JSON_SCHEMA.optional(),
  })
  .strict();

export const ConnectorCompleteSchema = z
  .object({ tools: z.array(ToolContractSchema).min(1).max(100) })
  .strict();

export type ConnectorCompleteInput = z.infer<typeof ConnectorCompleteSchema>;

async function readConnections(kernel: Kernel): Promise<ConnectorConnection[]> {
  const rows = await kernel.database
    .query<{ value: ConnectorConnection[] }>(`SELECT value FROM settings WHERE key = $1`, [
      CONNECTOR_CONNECTIONS_KEY,
    ])
    .catch(() => []);
  const value = rows[0]?.value;
  return Array.isArray(value) ? value : [];
}

async function writeConnections(
  kernel: Kernel,
  actor: string | null,
  connections: ConnectorConnection[],
): Promise<void> {
  await kernel.database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [CONNECTOR_CONNECTIONS_KEY, connections, actor ?? 'system'],
  );
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  );
}

/** HTTPS except on loopback (mock servers and local gateways). */
function checkedUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`${label} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid(`${label} must use http or https`);
  }
  if (url.username || url.password) throw invalid(`${label} must not embed credentials`);
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw invalid(`${label} must use https (plain http is allowed only on loopback)`);
  }
  return url;
}

function checkedHosts(hosts: string[], label: string): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()))].filter((host) => {
    if (!HOSTNAME.test(host)) throw invalid(`${label} host "${host}" is not a hostname`);
    return true;
  });
}

function egressRules(kernel: Kernel, connection: ConnectorConnection) {
  const rules = (kernel.config.egress?.allowlist ?? []).map((entry) => ({
    host: entry.host,
    dataClass: entry.dataClass,
  }));
  for (const host of connection.egressHosts) {
    rules.push({ host, dataClass: connection.defaultSensitivity });
  }
  if (connection.endpoint) {
    rules.push({
      host: new URL(connection.endpoint).hostname.toLowerCase(),
      dataClass: connection.defaultSensitivity,
    });
  }
  if (connection.oauth) {
    rules.push({
      host: new URL(connection.oauth.tokenEndpoint).hostname.toLowerCase(),
      dataClass: connection.defaultSensitivity,
    });
  }
  return rules;
}

function egressFor(kernel: Kernel, connection: ConnectorConnection): EgressClient {
  const rules = egressRules(kernel, connection);
  const hosts = new Set(rules.map((rule) => rule.host));
  if (connection.allowHost) {
    return new EgressClient(kernel.database, rules, { allowPrivateHosts: [...hosts] });
  }
  return new EgressClient(kernel.database, rules);
}

function tokenSecretName(connectionId: string): string {
  return `CONNECTOR_${connectionId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

async function readTokens(connection: ConnectorConnection): Promise<TokenSet | null> {
  if (!connection.oauth || !secretReader) return null;
  const raw = await secretReader.get(tokenSecretName(connection.id));
  if (!raw) return null;
  try {
    return TokenSetSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function schemaFromJson(value: Record<string, unknown>, label: string): ZodType {
  try {
    return z.fromJSONSchema(value as never);
  } catch {
    throw invalid(`${label} is not a supported JSON Schema`);
  }
}

function graphqlOperation(spec: StoredGraphqlOperation): GraphqlOperation {
  return {
    name: spec.name,
    kind: spec.kind,
    document: spec.document,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.variables ? { variables: spec.variables } : {}),
    ...(spec.headers ? { headers: spec.headers } : {}),
    ...(spec.inputSchema
      ? { inputSchema: schemaFromJson(spec.inputSchema, `GraphQL operation "${spec.name}" input`) }
      : {}),
    ...(spec.outputSchema
      ? {
          outputSchema: schemaFromJson(
            spec.outputSchema,
            `GraphQL operation "${spec.name}" output`,
          ),
        }
      : {}),
    ...(spec.scopes ? { scopes: spec.scopes } : {}),
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.examples ? { examples: spec.examples } : {}),
  };
}

function sqlQuery(spec: StoredSqlQuery): SqlQuery {
  return {
    name: spec.name,
    verb: spec.verb,
    sql: spec.sql,
    inputSchema: schemaFromJson(spec.inputSchema, `SQL query "${spec.name}" input`),
    outputSchema: schemaFromJson(spec.outputSchema, `SQL query "${spec.name}" output`),
    ...(spec.readOnly === undefined ? {} : { readOnly: spec.readOnly }),
    ...(spec.params ? { params: spec.params } : {}),
    ...(spec.columns ? { columns: spec.columns } : {}),
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.scopes ? { scopes: spec.scopes } : {}),
    ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.maxRows === undefined ? {} : { maxRows: spec.maxRows }),
    ...(spec.examples ? { examples: spec.examples } : {}),
  };
}

async function authHeaders(connection: ConnectorConnection): Promise<Record<string, string>> {
  if (!secretReader) return {};
  const secrets = connection.secrets;
  if (secrets.apiKey) {
    const value = await secretReader.get(secrets.apiKey);
    if (!value) throw policyBlocked(`connector secret ${secrets.apiKey} is not set`);
    return { authorization: `Bearer ${value}` };
  }
  if (secrets.header) {
    const value = await secretReader.get(secrets.header.secret);
    if (!value) throw policyBlocked(`connector secret ${secrets.header.secret} is not set`);
    return { [secrets.header.name.toLowerCase()]: value };
  }
  if (connection.oauth) {
    let tokens = await readTokens(connection);
    if (!tokens) {
      throw policyBlocked('connector OAuth connection needs authorization');
    }
    if (isTokenExpired(tokens) && tokens.refreshToken && secretReader.set) {
      const clientSecret = secrets.clientSecret
        ? await secretReader.get(secrets.clientSecret)
        : undefined;
      tokens = await refreshToken({
        tokenEndpoint: connection.oauth.tokenEndpoint,
        clientId: connection.oauth.clientId,
        ...(clientSecret ? { clientSecret } : {}),
        refreshToken: tokens.refreshToken,
      });
      await secretReader.set(
        tokenSecretName(connection.id),
        JSON.stringify(tokens),
        'system:connector-oauth',
      );
    }
    return { authorization: `${tokens.tokenType} ${tokens.accessToken}` };
  }
  return {};
}

function requestFor(kernel: Kernel, connection: ConnectorConnection): ConnectorFetch {
  return async (url, init) => {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(await authHeaders(connection))) {
      headers.set(key, value);
    }
    const egress = egressFor(kernel, connection);
    return egress.fetch(
      url,
      { ...init, headers },
      { actor: null, purpose: `connector:${connection.id}` },
    );
  };
}

function runnerFor(connection: ConnectorConnection, readOnly: boolean): SqlRunner {
  return {
    async run(request) {
      if (!secretReader) throw policyBlocked('the secret store is unavailable');
      const name = readOnly ? connection.secrets.readOnlyDsn : connection.secrets.dsn;
      if (!name) {
        throw policyBlocked(
          `connector ${connection.name} has no ${readOnly ? 'read-only' : 'read-write'} DSN secret`,
        );
      }
      const dsn = await secretReader.get(name);
      if (!dsn) throw policyBlocked(`connector secret ${name} is not set`);
      const runner = new PostgresSqlRunner({ url: dsn, readOnly });
      try {
        return await runner.run(request);
      } finally {
        await runner.close();
      }
    },
  };
}

function toolForSpec(
  kernel: Kernel,
  connection: ConnectorConnection,
  tool: StoredConnectorTool,
): {
  access: ToolAccess;
  idempotent: boolean;
  input: ZodType;
  output: ZodType;
  timeoutMs: number;
  execute: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
} {
  if (connection.kind === 'graphql') {
    const spec = connection.operations.find(
      (entry) => deriveGraphqlToolName(connection, entry) === tool.name,
    );
    if (!spec) throw notFound(`tool ${tool.name} has no imported GraphQL operation`);
    const [imported] = importGraphqlTools({
      endpoint: connection.endpoint ?? '',
      namespace: connection.namespace,
      operations: [graphqlOperation(spec)],
      request: requestFor(kernel, connection),
      allowWrites: connection.allowWrites,
    });
    if (!imported) throw invalid(`tool ${tool.name} could not be rebuilt`);
    return {
      access: imported.access,
      idempotent: imported.idempotent,
      input: imported.inputSchema,
      output: imported.outputSchema,
      timeoutMs: imported.timeoutMs,
      execute: imported.execute,
    };
  }
  const spec = connection.queries.find(
    (entry) => deriveSqlToolName(connection, entry) === tool.name,
  );
  if (!spec) throw notFound(`tool ${tool.name} has no imported SQL query`);
  const [imported] = importSqlTools({
    dialect: connection.dialect ?? 'postgres',
    namespace: connection.namespace,
    queries: [sqlQuery(spec)],
    runner: runnerFor(connection, false),
    readOnlyRunner: runnerFor(connection, true),
    allowWrites: connection.allowWrites,
  });
  if (!imported) throw invalid(`tool ${tool.name} could not be rebuilt`);
  return {
    access: imported.access,
    idempotent: imported.idempotent,
    input: imported.inputSchema,
    output: imported.outputSchema,
    timeoutMs: imported.timeoutMs,
    execute: imported.execute,
  };
}

function deriveGraphqlToolName(
  connection: ConnectorConnection,
  spec: StoredGraphqlOperation,
): string {
  const [imported] = importGraphqlTools({
    endpoint: connection.endpoint ?? '',
    namespace: connection.namespace,
    operations: [graphqlOperation(spec)],
    request: async () => new Response('{}', { status: 200 }),
    allowWrites: false,
  });
  return imported?.name ?? '';
}

function deriveSqlToolName(connection: ConnectorConnection, spec: StoredSqlQuery): string {
  const [imported] = importSqlTools({
    dialect: connection.dialect ?? 'postgres',
    namespace: connection.namespace,
    queries: [sqlQuery(spec)],
    runner: runnerFor(connection, false),
    readOnlyRunner: runnerFor(connection, true),
    allowWrites: false,
  });
  return imported?.name ?? '';
}

function definitionFor(
  kernel: Kernel,
  connection: ConnectorConnection,
  tool: StoredConnectorTool,
): ToolDefinition<unknown, unknown> {
  {
    const built = toolForSpec(kernel, connection, tool);
    const host = connection.endpoint ? new URL(connection.endpoint).hostname : null;
    return {
      name: tool.name,
      version: '0.1.0',
      owner: `connector:${connection.id}`,
      description: tool.description,
      examples: [{}],
      input: built.input,
      output: built.output,
      access: built.access,
      risk: tool.risk,
      scopes: tool.scopes,
      egressClass: connection.defaultSensitivity,
      ...(host ? { allowedHosts: [host] } : {}),
      idempotent: built.idempotent,
      timeoutMs: built.timeoutMs,
      undo: tool.undo,
      retry: { maxAttempts: 0, backoff: 'none', retryOn: [] },
      ...(built.access === 'write'
        ? {
            preview: async () => ({
              summary: `Run ${tool.name} on connector ${connection.name}`,
              affects: [connection.name],
            }),
          }
        : {}),
      handler: async (input, ctx) => {
        // 18.T16: connector egress obeys the same gate. A payload whose
        // sensitivity exceeds the connector's declared class is refused;
        // PII is masked when the class permits it.
        const payload = JSON.stringify(input ?? {});
        const detection = detect(payload);
        const gate = classifySend({
          sensitivity: detection.sensitivity,
          tags: detection.tags,
          hosted: false,
          egressClass: connection.defaultSensitivity,
        });
        if (gate.decision === 'withheld') {
          throw policyBlocked(
            `connector ${connection.name} cannot send this data (${gate.reason})`,
          );
        }
        const outbound =
          gate.decision === 'redacted'
            ? (JSON.parse(maskPii(payload, 'prompt').text) as unknown)
            : (input ?? {});
        return built.execute(outbound, { signal: ctx.signal });
      },
    };
  }
}

function view(connection: ConnectorConnection): ConnectorConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    namespace: connection.namespace,
    endpoint: connection.endpoint,
    dialect: connection.dialect,
    allowHost: connection.allowHost,
    egressHosts: connection.egressHosts,
    defaultSensitivity: connection.defaultSensitivity,
    allowWrites: connection.allowWrites,
    secretNames: connection.secrets,
    oauth: connection.oauth,
    status: connection.status,
    tools: connection.completedTools,
    sync: connection.sync,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    importedAt: connection.importedAt,
    lastError: connection.lastError,
  };
}

export async function listConnectorConnections(kernel: Kernel): Promise<ConnectorConnectionView[]> {
  return (await readConnections(kernel)).map(view);
}

function assertKindFields(input: ConnectorConnectionInput): void {
  if (input.kind === 'graphql') {
    checkedUrl(input.endpoint ?? '', 'GraphQL endpoint');
  } else {
    const support = sqlDialectSupport(input.dialect ?? 'postgres');
    if (!support.supported) throw invalid(support.reason);
  }
  if (input.oauth && input.kind !== 'graphql') {
    throw invalid('OAuth is supported for GraphQL connectors only');
  }
}

export async function addConnectorConnection(
  kernel: Kernel,
  input: ConnectorConnectionInput,
  actor: string | null,
): Promise<ConnectorConnectionView> {
  assertKindFields(input);
  const connections = await readConnections(kernel);
  if (connections.some((entry) => entry.name.toLowerCase() === input.name.toLowerCase())) {
    throw conflict(`a connector named ${input.name} already exists`);
  }
  const now = new Date().toISOString();
  const endpoint = input.endpoint
    ? checkedUrl(input.endpoint, 'GraphQL endpoint').toString()
    : null;
  const egressHosts = checkedHosts(
    [
      ...input.egressHosts,
      ...(endpoint ? [new URL(endpoint).hostname.toLowerCase()] : []),
      ...(input.oauth ? [new URL(input.oauth.tokenEndpoint).hostname.toLowerCase()] : []),
    ],
    'connector',
  );
  const connection: ConnectorConnection = {
    id: randomUUID(),
    name: input.name,
    kind: input.kind,
    namespace: input.namespace?.toLowerCase() ?? (input.kind === 'graphql' ? 'graphql' : 'sql'),
    endpoint,
    dialect: input.kind === 'sql' ? (input.dialect ?? 'postgres') : null,
    allowHost: input.allowHost,
    egressHosts,
    defaultSensitivity: input.defaultSensitivity,
    allowWrites: input.allowWrites,
    secrets: input.secrets ?? {},
    oauth: input.oauth ?? null,
    status: 'draft',
    operations: input.operations ?? [],
    queries: input.queries ?? [],
    completedTools: [],
    sync: input.sync ?? null,
    createdAt: now,
    updatedAt: now,
    importedAt: null,
    lastError: null,
  };
  await writeConnections(kernel, actor, [...connections, connection]);
  await writeAudit(kernel.database, {
    actor,
    action: 'connector.created',
    subject: connection.id,
    payload: { name: connection.name, kind: connection.kind, allowWrites: connection.allowWrites },
  });
  return view(connection);
}

export async function updateConnectorConnection(
  kernel: Kernel,
  id: string,
  input: z.infer<typeof ConnectorUpdateSchema>,
  actor: string | null,
): Promise<ConnectorConnectionView> {
  const connections = await readConnections(kernel);
  const connection = connections.find((entry) => entry.id === id);
  if (!connection) throw notFound(`connector ${id} not found`);
  if (input.name !== undefined) connection.name = input.name;
  if (input.allowHost !== undefined) connection.allowHost = input.allowHost;
  if (input.defaultSensitivity !== undefined) {
    connection.defaultSensitivity = input.defaultSensitivity;
  }
  if (input.allowWrites !== undefined) connection.allowWrites = input.allowWrites;
  if (input.secrets !== undefined) connection.secrets = input.secrets;
  if (input.oauth !== undefined) {
    connection.oauth = input.oauth;
    if (input.oauth) {
      const tokenHost = new URL(input.oauth.tokenEndpoint).hostname.toLowerCase();
      if (!connection.egressHosts.includes(tokenHost)) connection.egressHosts.push(tokenHost);
    }
  }
  if (input.operations !== undefined) connection.operations = input.operations;
  if (input.queries !== undefined) connection.queries = input.queries;
  if (input.sync !== undefined) connection.sync = input.sync;
  if (input.egressHosts !== undefined)
    connection.egressHosts = checkedHosts(input.egressHosts, 'connector');
  connection.updatedAt = new Date().toISOString();
  await writeConnections(kernel, actor, connections);
  await writeAudit(kernel.database, {
    actor,
    action: 'connector.updated',
    subject: connection.id,
    payload: { name: connection.name },
  });
  return view(connection);
}

export async function removeConnectorConnection(
  kernel: Kernel,
  id: string,
  actor: string | null,
): Promise<{ removed: boolean }> {
  const connections = await readConnections(kernel);
  const connection = connections.find((entry) => entry.id === id);
  if (!connection) throw notFound(`connector ${id} not found`);
  await writeConnections(
    kernel,
    actor,
    connections.filter((entry) => entry.id !== id),
  );
  if (connection.oauth && secretReader?.delete) {
    await secretReader.delete(tokenSecretName(connection.id), actor ?? 'system').catch(() => false);
  }
  await writeAudit(kernel.database, {
    actor,
    action: 'connector.removed',
    subject: connection.id,
    payload: { name: connection.name },
  });
  return { removed: true };
}

interface ImportedSummary {
  name: string;
  access: ToolAccess;
  risk: 'low' | 'high';
  complete: boolean;
}

export async function importConnectorConnection(
  kernel: Kernel,
  id: string,
  input: z.infer<typeof ConnectorImportSchema>,
  actor: string | null,
): Promise<{ connectionId: string; imported: ImportedSummary[]; tools: StoredConnectorTool[] }> {
  const connections = await readConnections(kernel);
  const connection = connections.find((entry) => entry.id === id);
  if (!connection) throw notFound(`connector ${id} not found`);
  if (connection.kind === 'graphql' && input.queries?.length) {
    throw invalid('queries are only valid for SQL connectors');
  }
  if (connection.kind === 'sql' && input.operations?.length) {
    throw invalid('operations are only valid for GraphQL connectors');
  }
  if (input.operations !== undefined) connection.operations = input.operations;
  if (input.queries !== undefined) connection.queries = input.queries;

  const previous = new Map(connection.completedTools.map((tool) => [tool.name, tool]));
  const imported: ImportedSummary[] = [];
  const tools: StoredConnectorTool[] = [];

  if (connection.kind === 'graphql') {
    if (connection.operations.length === 0) {
      throw invalid('no GraphQL operations to import; send operations or save them first');
    }
    const built = importGraphqlTools({
      endpoint: connection.endpoint ?? '',
      namespace: connection.namespace,
      operations: connection.operations.map(graphqlOperation),
      request: requestFor(kernel, connection),
      allowWrites: false,
    });
    for (const tool of built) {
      const prior = previous.get(tool.name);
      if (prior?.completed) {
        tools.push(prior);
        imported.push({ name: tool.name, access: prior.access, risk: prior.risk, complete: true });
        continue;
      }
      const stored: StoredConnectorTool = {
        name: tool.name,
        description: tool.description,
        access: tool.access,
        risk: tool.risk,
        undo: tool.undo,
        idempotent: tool.idempotent,
        scopes: tool.scopes,
        timeoutMs: tool.timeoutMs,
        enabled: false,
        completed: false,
      };
      tools.push(stored);
      imported.push({
        name: tool.name,
        access: tool.access,
        risk: tool.risk,
        complete: tool.complete,
      });
    }
  } else {
    if (connection.queries.length === 0) {
      throw invalid('no SQL queries to import; send queries or save them first');
    }
    const built = importSqlTools({
      dialect: connection.dialect ?? 'postgres',
      namespace: connection.namespace,
      queries: connection.queries.map(sqlQuery),
      runner: runnerFor(connection, false),
      readOnlyRunner: runnerFor(connection, true),
      allowWrites: false,
    });
    for (const tool of built) {
      const prior = previous.get(tool.name);
      if (prior?.completed) {
        tools.push(prior);
        imported.push({ name: tool.name, access: prior.access, risk: prior.risk, complete: true });
        continue;
      }
      const stored: StoredConnectorTool = {
        name: tool.name,
        description: tool.description,
        access: tool.access,
        risk: tool.risk,
        undo: tool.undo,
        idempotent: tool.idempotent,
        scopes: tool.scopes,
        timeoutMs: tool.timeoutMs,
        enabled: false,
        completed: false,
      };
      tools.push(stored);
      imported.push({
        name: tool.name,
        access: tool.access,
        risk: tool.risk,
        complete: tool.complete,
      });
    }
  }

  connection.completedTools = tools;
  connection.importedAt = new Date().toISOString();
  connection.updatedAt = connection.importedAt;
  connection.status = connection.completedTools.some((tool) => tool.completed)
    ? connection.status
    : 'draft';
  await writeConnections(kernel, actor, connections);
  await writeAudit(kernel.database, {
    actor,
    action: 'connector.imported',
    subject: connection.id,
    payload: { tools: imported.map((tool) => tool.name) },
  });
  return { connectionId: connection.id, imported, tools };
}

function specIsComplete(connection: ConnectorConnection, tool: StoredConnectorTool): boolean {
  if (connection.kind === 'graphql') {
    const spec = connection.operations.find(
      (entry) => deriveGraphqlToolName(connection, entry) === tool.name,
    );
    return Boolean(spec?.inputSchema && spec.outputSchema);
  }
  const spec = connection.queries.find(
    (entry) => deriveSqlToolName(connection, entry) === tool.name,
  );
  return Boolean(spec?.inputSchema && spec.outputSchema);
}

function applyContractSchema(
  connection: ConnectorConnection,
  tool: StoredConnectorTool,
  contract: z.infer<typeof ToolContractSchema>,
  label: string,
): void {
  if (connection.kind === 'graphql') {
    const spec = connection.operations.find(
      (entry) => deriveGraphqlToolName(connection, entry) === tool.name,
    );
    if (!spec) throw notFound(`tool ${tool.name} has no imported GraphQL operation`);
    if (contract.inputSchema) {
      schemaFromJson(contract.inputSchema, `${label} inputSchema`);
      spec.inputSchema = contract.inputSchema;
    }
    if (contract.outputSchema) {
      schemaFromJson(contract.outputSchema, `${label} outputSchema`);
      spec.outputSchema = contract.outputSchema;
    }
    return;
  }
  const spec = connection.queries.find(
    (entry) => deriveSqlToolName(connection, entry) === tool.name,
  );
  if (!spec) throw notFound(`tool ${tool.name} has no imported SQL query`);
  if (contract.inputSchema) {
    schemaFromJson(contract.inputSchema, `${label} inputSchema`);
    spec.inputSchema = contract.inputSchema;
  }
  if (contract.outputSchema) {
    schemaFromJson(contract.outputSchema, `${label} outputSchema`);
    spec.outputSchema = contract.outputSchema;
  }
}

export async function completeConnectorConnection(
  kernel: Kernel,
  id: string,
  input: ConnectorCompleteInput,
  actor: string | null,
): Promise<{ connectionId: string; registered: string[]; tools: StoredConnectorTool[] }> {
  const connections = await readConnections(kernel);
  const connection = connections.find((entry) => entry.id === id);
  if (!connection) throw notFound(`connector ${id} not found`);
  if (!connection.importedAt) throw invalid(`connector ${id} has no imported tools`);

  const byName = new Map(connection.completedTools.map((tool) => [tool.name, tool]));
  const definitions: Array<ToolDefinition<unknown, unknown>> = [];

  for (const contract of input.tools) {
    const tool = byName.get(contract.name);
    if (!tool) throw notFound(`connector tool ${contract.name} is not imported on ${id}`);
    applyContractSchema(connection, tool, contract, `connector tool ${tool.name}`);

    const built = toolForSpec(kernel, connection, tool);
    const access = built.access;
    const description = contract.description ?? tool.description;
    if (!specIsComplete(connection, tool)) {
      throw invalid(
        `connector tool ${tool.name} needs both inputSchema and outputSchema before it can be enabled`,
      );
    }
    const enabled =
      access === 'write'
        ? connection.allowWrites && contract.enabled === true
        : (contract.enabled ?? true);
    if (access === 'write' && enabled) {
      if (!connection.allowWrites) throw invalid('writes are disabled on this connector');
      if (connection.kind === 'sql' && !connection.secrets.dsn) {
        throw invalid(`SQL connector ${connection.id} needs a read-write DSN secret for writes`);
      }
    }
    if (
      access === 'read' &&
      connection.kind === 'sql' &&
      enabled &&
      !connection.secrets.readOnlyDsn
    ) {
      throw invalid(`SQL connector ${connection.id} needs a read-only DSN secret for reads`);
    }
    const next: StoredConnectorTool = {
      ...tool,
      description,
      scopes: contract.scopes ?? tool.scopes,
      access,
      risk: access === 'write' ? 'high' : 'low',
      undo: access === 'write' ? 'none' : 'free',
      idempotent: access === 'read',
      timeoutMs: contract.timeoutMs ?? tool.timeoutMs,
      enabled,
      completed: true,
    };
    byName.set(next.name, next);
    if (!next.enabled) continue;
    const definition = definitionFor(kernel, connection, next);
    const problems = validateToolDefinition(definition);
    if (problems.length > 0) {
      throw invalid(`invalid contract for connector tool ${tool.name}`, problems);
    }
    const existing = kernel.tools.get(definition.name);
    if (existing && existing.owner !== definition.owner) {
      throw conflict(`tool ${definition.name} is already registered by ${existing.owner}`);
    }
    definitions.push(definition);
  }

  // Validate every contract before registering any of them.
  const registered: string[] = [];
  for (const definition of definitions) {
    if (kernel.tools.get(definition.name)) continue;
    kernel.tools.register(definition);
    registered.push(definition.name);
  }

  connection.completedTools = [...byName.values()];
  connection.status = connection.completedTools.some((tool) => tool.completed) ? 'ready' : 'draft';
  connection.updatedAt = new Date().toISOString();
  await writeConnections(kernel, actor, connections);
  await writeAudit(kernel.database, {
    actor,
    action: 'connector.completed',
    subject: connection.id,
    payload: { registered, tools: connection.completedTools.map((tool) => tool.name) },
  });
  return { connectionId: connection.id, registered, tools: connection.completedTools };
}

/**
 * Re-register completed connector tools after a boot or soft reload. A stale
 * contract is reported, never fatal: the admin can re-complete it. The sync
 * stage (follow-up) is registered here too so a new engine generation has it.
 */
export async function restoreConnectorTools(
  kernel: Kernel,
  secrets?: ConnectorSecretReader,
): Promise<{ registered: string[]; failed: Array<{ name: string; reason: string }> }> {
  if (secrets) setConnectorSecretReader(secrets);
  const registered: string[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const connection of await readConnections(kernel)) {
    for (const tool of connection.completedTools) {
      if (!tool.completed || !tool.enabled) continue;
      if (kernel.tools.get(tool.name)) continue;
      try {
        const definition = definitionFor(kernel, connection, tool);
        const problems = validateToolDefinition(definition);
        if (problems.length > 0) throw new Error(problems.join('; '));
        kernel.tools.register(definition);
        registered.push(definition.name);
      } catch (err) {
        failed.push({ name: tool.name, reason: (err as Error).message });
      }
    }
  }
  return { registered, failed };
}

export async function testConnectorConnection(
  kernel: Kernel,
  id: string,
): Promise<{ ok: boolean; status: number | null; latencyMs: number; error?: string }> {
  const connections = await readConnections(kernel);
  const connection = connections.find((entry) => entry.id === id);
  if (!connection) throw notFound(`connector ${id} not found`);
  const started = Date.now();
  try {
    if (connection.kind === 'graphql') {
      const response = await requestFor(kernel, connection)(connection.endpoint ?? '', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'query ConnectorProbe { __typename }' }),
        signal: AbortSignal.timeout(5_000),
      });
      return { ok: response.ok, status: response.status, latencyMs: Date.now() - started };
    }
    await runnerFor(connection, true).run({
      name: 'connector_probe',
      sql: 'SELECT 1 AS ok',
      params: [],
      readOnly: true,
      timeoutMs: 5_000,
      maxRows: 1,
    });
    return { ok: true, status: null, latencyMs: Date.now() - started };
  } catch (err) {
    const message = (err as Error).message;
    await writeAudit(kernel.database, {
      actor: null,
      action: 'connector.test_failed',
      subject: connection.id,
      payload: { message },
    });
    return { ok: false, status: null, latencyMs: Date.now() - started, error: message };
  }
}

const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingOAuth {
  connectionId: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  actor: string | null;
  createdAt: string;
}

/** Begin authorization-code + PKCE; the state/nonce/verifier never leave the server. */
export async function startConnectorOAuth(
  kernel: Kernel,
  id: string,
  actor: string | null,
): Promise<{ authorizeUrl: string; state: string; redirectUri: string }> {
  const connection = (await readConnections(kernel)).find((entry) => entry.id === id);
  if (!connection) throw notFound(`connector ${id} not found`);
  if (!connection.oauth) throw invalid(`connector ${id} has no OAuth configuration`);
  const pkce = createPkce();
  const state = randomBytes(24).toString('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const pending: PendingOAuth = {
    connectionId: connection.id,
    verifier: pkce.verifier,
    nonce,
    redirectUri: connection.oauth.redirectUri,
    actor,
    createdAt: new Date().toISOString(),
  };
  await kernel.database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [`connector.oauth.${state}`, pending, actor ?? 'system:connector-oauth'],
  );
  await writeAudit(kernel.database, {
    actor,
    action: 'connector.oauth_started',
    subject: connection.id,
    payload: { authorizationEndpoint: connection.oauth.authorizationEndpoint },
  });
  return {
    authorizeUrl: authorizeUrl({
      authorizationEndpoint: connection.oauth.authorizationEndpoint,
      clientId: connection.oauth.clientId,
      redirectUri: connection.oauth.redirectUri,
      scopes: connection.oauth.scopes,
      state,
      codeChallenge: pkce.challenge,
      nonce,
    }),
    state,
    redirectUri: connection.oauth.redirectUri,
  };
}

/** Finish authorization: validate state/nonce, exchange the code, store tokens. */
export async function completeConnectorOAuth(
  kernel: Kernel,
  input: { state: string; code: string; nonce?: string },
  actor: string | null,
): Promise<{ connectionId: string; status: string; successRedirect: string | null }> {
  const key = `connector.oauth.${input.state}`;
  const rows = await kernel.database.query<{ value: PendingOAuth }>(
    `SELECT value FROM settings WHERE key = $1`,
    [key],
  );
  const pending = rows[0]?.value;
  if (!pending) throw invalid('unknown or already-used OAuth state');
  await kernel.database.query(`DELETE FROM settings WHERE key = $1`, [key]);
  validateState(input.state, input.state);
  if (input.nonce) validateNonce(pending.nonce, input.nonce);
  const age = Date.now() - new Date(pending.createdAt).getTime();
  if (!Number.isFinite(age) || age > OAUTH_PENDING_TTL_MS || age < 0) {
    throw invalid('OAuth authorization expired; start again');
  }
  const connections = await readConnections(kernel);
  const connection = connections.find((entry) => entry.id === pending.connectionId);
  if (!connection || !connection.oauth) throw notFound('connector no longer exists');
  if (!secretReader?.set) throw policyBlocked('the secret store is unavailable');
  const clientSecret = connection.secrets.clientSecret
    ? await secretReader.get(connection.secrets.clientSecret)
    : null;
  let tokens: TokenSet;
  try {
    tokens = await exchangeCode({
      tokenEndpoint: connection.oauth.tokenEndpoint,
      clientId: connection.oauth.clientId,
      ...(clientSecret ? { clientSecret } : {}),
      code: input.code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
  } catch (err) {
    connection.status = 'needs_reauth';
    connection.lastError = (err as Error).message.slice(0, 300);
    connection.updatedAt = new Date().toISOString();
    await writeConnections(kernel, actor ?? pending.actor, connections);
    await writeAudit(kernel.database, {
      actor: actor ?? pending.actor,
      action: 'connector.oauth_failed',
      subject: connection.id,
      payload: { reason: connection.lastError },
    });
    throw policyBlocked(`OAuth token exchange failed: ${connection.lastError}`);
  }
  await secretReader.set(
    tokenSecretName(connection.id),
    JSON.stringify(tokens),
    actor ?? 'system:connector-oauth',
  );
  connection.status = 'ready';
  connection.lastError = null;
  connection.updatedAt = new Date().toISOString();
  await writeConnections(kernel, actor ?? pending.actor, connections);
  await writeAudit(kernel.database, {
    actor: actor ?? pending.actor,
    action: 'connector.oauth_authorized',
    subject: connection.id,
    payload: { scope: tokens.scope ?? null, expiresAt: tokens.expiresAt },
  });
  return {
    connectionId: connection.id,
    status: 'ready',
    successRedirect: connection.oauth.successRedirect ?? null,
  };
}
