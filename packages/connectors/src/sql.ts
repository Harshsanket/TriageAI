/**
 * Named SQL query connector (Phase 15.T7). Admins author parameterised
 * queries; free-form text-to-SQL is not part of this API. Reads run on the
 * read-only runner when one is supplied, writes are disabled unless the import
 * explicitly enables them, and every result is capped and column-allowlisted.
 *
 * Only Postgres has a built-in runner. The `SqlRunner` interface is the dialect
 * seam: another dialect gets a runner plus a documented placeholder/timeout
 * mapping, not a half-working copy of this file.
 */
import postgres from 'postgres';
import { z } from 'zod';
import type { ZodType } from 'zod';

import {
  assertInputPath,
  assertSchema,
  assertUniqueNames,
  checkedInteger,
  checkedTimeout,
  describeConnector,
  isPlainObject,
  normalizeExamples,
  normalizeNamespace,
  normalizeScopes,
  parseInput,
  parseOutput,
  readPath,
  RESERVED_INPUT_KEYS,
  sqlToolName,
} from './helpers.js';
import { ConnectorError } from './types.js';
import type { ConnectorExecuteOptions, ConnectorToolDescriptor } from './types.js';

export const SQL_DIALECTS = ['postgres', 'mysql', 'sqlite', 'sqlserver'] as const;
export type SqlDialect = (typeof SQL_DIALECTS)[number];

export type SqlVerb = 'get' | 'list' | 'search' | 'create' | 'update' | 'delete' | 'send' | 'run';

export interface SqlQuery {
  /** Admin-facing query name; the tool name is derived from it. */
  name: string;
  verb: SqlVerb;
  /** Exactly one statement. Use `$1..$n` (with `params`) or `:name` placeholders. */
  sql: string;
  inputSchema: ZodType;
  /** Validated against each result row after the column allowlist. */
  outputSchema: ZodType;
  /** Defaults to true for get/list/search and to false for writes. */
  readOnly?: boolean;
  /** Input field paths bound to `$1..$n` (index 0 is `$1`). */
  params?: string[];
  /** Result columns to keep; every other column is dropped and reported. */
  columns?: string[];
  description?: string;
  scopes?: string[];
  timeoutMs?: number;
  maxRows?: number;
  examples?: unknown[];
}

export interface SqlQueryRequest {
  name: string;
  /** Validated, single-statement SQL with `$n` placeholders. */
  sql: string;
  params: unknown[];
  /** Defaults to the runner's configured timeout when omitted. */
  timeoutMs?: number;
  /** Defaults to the runner's configured row cap when omitted. */
  maxRows?: number;
  /** Defaults to true: a runner call is read-only unless it says otherwise. */
  readOnly?: boolean;
  signal?: AbortSignal;
}

export interface SqlRunnerResult {
  rows: Array<Record<string, unknown>>;
  truncated?: boolean;
}

/** Injected database capability; the host owns the connection and the role. */
export interface SqlRunner {
  run(request: SqlQueryRequest): Promise<SqlRunnerResult>;
}

export interface SqlToolResult<O = unknown> {
  rows: O[];
  rowCount: number;
  truncated: boolean;
  /** Columns present in the result (or the allowlist when one is configured). */
  columns: string[];
  /** Columns dropped because they were outside the allowlist. */
  omittedColumns: string[];
}

/**
 * The tool-level output schema: `query.outputSchema` describes one row, but a
 * kernel `ToolDefinition.output` validates the whole handler result. Register
 * this envelope schema (not the row schema) on the tool definition.
 */
export function sqlToolOutputSchema<O = unknown>(rowSchema: ZodType<O>): ZodType<SqlToolResult<O>> {
  return z.object({
    rows: z.array(rowSchema),
    rowCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    columns: z.array(z.string()),
    omittedColumns: z.array(z.string()),
  }) as ZodType<SqlToolResult<O>>;
}

export interface ImportedSqlTool extends ConnectorToolDescriptor {
  kind: 'sql';
  dialect: SqlDialect;
  query: SqlQuery;
  execute(input: unknown, options?: ConnectorExecuteOptions): Promise<SqlToolResult>;
}

export interface SqlImportOptions {
  dialect: SqlDialect;
  namespace?: string;
  queries: SqlQuery[];
  runner: SqlRunner;
  /** Used for read-only queries when present (operator-created read-only role). */
  readOnlyRunner?: SqlRunner;
  /** Writes start disabled; set only after an admin completes the contract. */
  allowWrites?: boolean;
  timeoutMs?: number;
  maxRows?: number;
}

export interface SqlDialectSupport {
  dialect: SqlDialect;
  supported: boolean;
  reason: string;
}

const READ_VERBS = new Set<SqlVerb>(['get', 'list', 'search']);
const WRITE_VERBS = new Set<SqlVerb>(['create', 'update', 'delete', 'send']);
const SQL_VERBS = new Set<SqlVerb>([
  'get',
  'list',
  'search',
  'create',
  'update',
  'delete',
  'send',
  'run',
]);

const WRITE_KEYWORDS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'upsert',
  'create',
  'alter',
  'drop',
  'truncate',
  'grant',
  'revoke',
  'comment',
  'copy',
  'call',
  'do',
  'execute',
  'vacuum',
  'analyze',
  'reindex',
  'cluster',
  'refresh',
  'lock',
  'set',
  'reset',
  'discard',
  'listen',
  'notify',
  'unlisten',
  'prepare',
  'deallocate',
  'declare',
  'fetch',
  'move',
  'close',
  'begin',
  'start',
  'commit',
  'rollback',
  'savepoint',
  'release',
  'nextval',
  'setval',
  'into',
]);

interface ScannedSql {
  sql: string;
  named: string[];
  positional: number[];
  tokens: string[];
}

function unsupportedDialect(dialect: SqlDialect, reason: string): ConnectorError {
  return new ConnectorError('connector.SQL_DIALECT_UNSUPPORTED', reason, { details: { dialect } });
}

export function sqlDialectSupport(dialect: SqlDialect): SqlDialectSupport {
  if (!(SQL_DIALECTS as readonly string[]).includes(dialect)) {
    return { dialect, supported: false, reason: `unknown SQL dialect "${dialect}"` };
  }
  if (dialect === 'postgres') {
    return { dialect, supported: true, reason: 'PostgresSqlRunner is built in' };
  }
  return {
    dialect,
    supported: false,
    reason: `SQL dialect "${dialect}" is not implemented; only Postgres has a built-in runner.`,
  };
}

function scanSql(sqlText: string, label: string): ScannedSql {
  if (typeof sqlText !== 'string' || !sqlText.trim()) {
    throw new ConnectorError('connector.SQL_INVALID', `${label} needs one SQL statement`);
  }
  if (sqlText.includes('${')) {
    throw new ConnectorError(
      'connector.SQL_TEMPLATE_INTERPOLATION',
      `${label} must not use string interpolation; bind values with $1 or :name placeholders`,
    );
  }
  if (sqlText.includes('`')) {
    throw new ConnectorError(
      'connector.SQL_TEMPLATE_INTERPOLATION',
      `${label} must not use backtick interpolation; bind values with $1 or :name placeholders`,
    );
  }

  let output = '';
  let index = 0;
  let semicolons = 0;
  const named: string[] = [];
  const namedIndex = new Map<string, number>();
  const positional = new Set<number>();
  const tokens: string[] = [];

  const unterminated = (what: string): never => {
    throw new ConnectorError('connector.SQL_INVALID', `${label} has an unterminated ${what}`);
  };
  const multipleStatements = (): never => {
    throw new ConnectorError(
      'connector.SQL_MULTIPLE_STATEMENTS',
      `${label} must contain exactly one statement`,
    );
  };

  while (index < sqlText.length) {
    const char = sqlText[index] as string;
    const next = sqlText[index + 1];

    if (char === '-' && next === '-') {
      const end = sqlText.indexOf('\n', index + 2);
      const stop = end < 0 ? sqlText.length : end;
      output += sqlText.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && next === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sqlText.length && depth > 0) {
        if (sqlText[cursor] === '/' && sqlText[cursor + 1] === '*') {
          depth++;
          cursor += 2;
          continue;
        }
        if (sqlText[cursor] === '*' && sqlText[cursor + 1] === '/') {
          depth--;
          cursor += 2;
          continue;
        }
        cursor++;
      }
      if (depth > 0) unterminated('block comment');
      output += sqlText.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (char === "'") {
      let cursor = index + 1;
      let closed = false;
      while (cursor < sqlText.length) {
        if (sqlText[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (sqlText[cursor] === "'") {
          if (sqlText[cursor + 1] === "'") {
            cursor += 2;
            continue;
          }
          cursor++;
          closed = true;
          break;
        }
        cursor++;
      }
      if (!closed) unterminated('string literal');
      output += sqlText.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (char === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < sqlText.length) {
        if (sqlText[cursor] === '"') {
          if (sqlText[cursor + 1] === '"') {
            cursor += 2;
            continue;
          }
          cursor++;
          closed = true;
          break;
        }
        cursor++;
      }
      if (!closed) unterminated('quoted identifier');
      output += sqlText.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (char === '$') {
      const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sqlText.slice(index));
      if (dollar) {
        const tag = dollar[0];
        const end = sqlText.indexOf(tag, index + tag.length);
        if (end < 0) unterminated('dollar-quoted string');
        const stop = end + tag.length;
        output += sqlText.slice(index, stop);
        index = stop;
        continue;
      }
      if (next !== undefined && /[0-9]/.test(next)) {
        let cursor = index + 1;
        while (cursor < sqlText.length && /[0-9]/.test(sqlText[cursor] as string)) cursor++;
        const position = Number(sqlText.slice(index + 1, cursor));
        if (!Number.isInteger(position) || position < 1) {
          throw new ConnectorError('connector.SQL_INVALID', `${label} has an invalid placeholder`);
        }
        positional.add(position);
        output += sqlText.slice(index, cursor);
        index = cursor;
        continue;
      }
      output += char;
      index++;
      continue;
    }
    if (char === ':') {
      if (next === ':' || next === '=') {
        output += char;
        index++;
        continue;
      }
      if (index > 0 && sqlText[index - 1] === ':') {
        output += char;
        index++;
        continue;
      }
      const namedMatch = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sqlText.slice(index));
      if (namedMatch) {
        const name = namedMatch[1] as string;
        let position = namedIndex.get(name);
        if (position === undefined) {
          named.push(name);
          position = named.length;
          namedIndex.set(name, position);
        }
        output += `$${position}`;
        index += namedMatch[0].length;
        continue;
      }
      output += char;
      index++;
      continue;
    }
    if (char === ';') {
      semicolons++;
      output += char;
      index++;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let cursor = index + 1;
      while (cursor < sqlText.length && /[A-Za-z0-9_$]/.test(sqlText[cursor] as string)) cursor++;
      tokens.push(sqlText.slice(index, cursor).toLowerCase());
      output += sqlText.slice(index, cursor);
      index = cursor;
      continue;
    }
    output += char;
    index++;
  }

  let text = output.trimEnd();
  if (text.endsWith(';')) {
    if (semicolons > 1) multipleStatements();
    text = text.slice(0, -1).trimEnd();
  } else if (semicolons > 0) {
    multipleStatements();
  }
  if (!text) {
    throw new ConnectorError('connector.SQL_INVALID', `${label} needs one SQL statement`);
  }
  return { sql: text, named, positional: [...positional].sort((a, b) => a - b), tokens };
}

function assertReadOnlySql(scanned: ScannedSql, label: string): void {
  for (let index = 0; index < scanned.tokens.length - 1; index++) {
    if (
      scanned.tokens[index] === 'for' &&
      ['update', 'share', 'no', 'key'].includes(scanned.tokens[index + 1] as string)
    ) {
      throw new ConnectorError(
        'connector.SQL_WRITE_IN_READ_ONLY',
        `${label} is read-only but uses a row-locking clause`,
      );
    }
  }
  for (const token of scanned.tokens) {
    if (WRITE_KEYWORDS.has(token)) {
      throw new ConnectorError(
        'connector.SQL_WRITE_IN_READ_ONLY',
        `${label} is read-only but its SQL uses "${token}"`,
      );
    }
  }
}

function validatePlaceholders(query: SqlQuery, scanned: ScannedSql, label: string): void {
  if (scanned.named.length > 0 && scanned.positional.length > 0) {
    throw new ConnectorError(
      'connector.SQL_PARAMETER_MISMATCH',
      `${label} mixes :name and $n placeholders; use one style`,
    );
  }
  if (query.params !== undefined && !Array.isArray(query.params)) {
    throw new ConnectorError(
      'connector.SQL_PARAMETER_MISMATCH',
      `${label} params must be an array`,
    );
  }
  if (scanned.named.length > 0) {
    if (query.params !== undefined) {
      throw new ConnectorError(
        'connector.SQL_PARAMETER_MISMATCH',
        `${label} uses :name placeholders; omit params (names bind to input fields)`,
      );
    }
    const shape = (query.inputSchema as { shape?: Record<string, unknown> }).shape;
    if (shape) {
      for (const name of scanned.named) {
        if (RESERVED_INPUT_KEYS.has(name) || !Object.hasOwn(shape, name)) {
          throw new ConnectorError(
            'connector.SQL_PARAMETER_MISMATCH',
            `${label} placeholder ":${name}" is not a field of its input schema`,
          );
        }
      }
    } else {
      for (const name of scanned.named) {
        if (RESERVED_INPUT_KEYS.has(name)) {
          throw new ConnectorError(
            'connector.SQL_PARAMETER_MISMATCH',
            `${label} placeholder ":${name}" is a reserved key`,
          );
        }
      }
    }
    return;
  }
  if (scanned.positional.length === 0) {
    if (query.params && query.params.length > 0) {
      throw new ConnectorError(
        'connector.SQL_PARAMETER_MISMATCH',
        `${label} declares params but its SQL has no $n placeholders`,
      );
    }
    return;
  }
  const max = scanned.positional[scanned.positional.length - 1] as number;
  const params = query.params ?? [];
  if (params.length !== max) {
    throw new ConnectorError(
      'connector.SQL_PARAMETER_MISMATCH',
      `${label} uses $1..$${max} but declares ${params.length} params`,
    );
  }
  for (let position = 1; position <= max; position++) {
    if (!scanned.positional.includes(position)) {
      throw new ConnectorError(
        'connector.SQL_PARAMETER_MISMATCH',
        `${label} is missing a binding for $${position}`,
      );
    }
  }
  for (const path of params) {
    assertInputPath(path, label);
  }
}

function normalizeColumns(columns: string[] | undefined, label: string): string[] | undefined {
  if (columns === undefined) return undefined;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new ConnectorError('connector.SQL_COLUMNS_INVALID', `${label} columns must be an array`);
  }
  for (const column of columns) {
    if (
      typeof column !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(column) ||
      RESERVED_INPUT_KEYS.has(column)
    ) {
      throw new ConnectorError(
        'connector.SQL_COLUMNS_INVALID',
        `${label} column "${column}" must be a plain identifier`,
      );
    }
  }
  return [...new Set(columns)];
}

function bindParameters(
  input: unknown,
  scanned: ScannedSql,
  params: string[] | undefined,
  label: string,
): unknown[] {
  if (!isPlainObject(input)) {
    if (scanned.named.length > 0 || (params?.length ?? 0) > 0) {
      throw new ConnectorError('connector.INPUT_INVALID', `${label} input must be an object`);
    }
    return [];
  }
  if (scanned.named.length > 0) {
    return scanned.named.map((name) => (Object.hasOwn(input, name) ? input[name] : undefined));
  }
  return (params ?? []).map((path) => readPath(input, path));
}

function resultColumns(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key) || RESERVED_INPUT_KEYS.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

function projectRow(
  row: Record<string, unknown>,
  columns: string[],
  allowlist: boolean,
): Record<string, unknown> {
  if (!allowlist) return row;
  const projected: Record<string, unknown> = {};
  for (const column of columns) {
    if (RESERVED_INPUT_KEYS.has(column)) continue;
    if (Object.hasOwn(row, column)) projected[column] = row[column];
  }
  return projected;
}

export function importSqlTools(options: SqlImportOptions): ImportedSqlTool[] {
  const support = sqlDialectSupport(options.dialect);
  if (!support.supported) throw unsupportedDialect(options.dialect, support.reason);
  if (!options.runner || typeof options.runner.run !== 'function') {
    throw new ConnectorError(
      'connector.SQL_RUNNER_REQUIRED',
      'an injected SqlRunner is required for SQL imports',
    );
  }
  if (options.readOnlyRunner && typeof options.readOnlyRunner.run !== 'function') {
    throw new ConnectorError(
      'connector.SQL_RUNNER_REQUIRED',
      'readOnlyRunner must implement SqlRunner.run',
    );
  }

  const namespace = normalizeNamespace(options.namespace, 'sql');
  const allowWrites = options.allowWrites === true;
  const defaultTimeout = checkedTimeout(options.timeoutMs, 5_000, 'SQL');
  const defaultMaxRows = checkedInteger(options.maxRows, 100, 1, 10_000, 'SQL maxRows');
  if (!Array.isArray(options.queries)) {
    throw new ConnectorError('connector.SQL_INVALID', 'SQL import queries must be an array');
  }
  const tools: ImportedSqlTool[] = [];

  for (const query of options.queries) {
    if (!query || typeof query !== 'object') {
      throw new ConnectorError('connector.SQL_INVALID', 'every SQL import query must be an object');
    }
    const label = `SQL query "${query.name}"`;
    if (typeof query.name !== 'string' || !query.name.trim()) {
      throw new ConnectorError('connector.SQL_INVALID', 'every SQL query needs a name');
    }
    if (!SQL_VERBS.has(query.verb)) {
      throw new ConnectorError(
        'connector.SQL_INVALID',
        `${label} verb "${query.verb}" is not in the fixed verb set`,
      );
    }
    const inputSchema = assertSchema(query.inputSchema, `${label} inputSchema`);
    const outputSchema = assertSchema(query.outputSchema, `${label} outputSchema`);
    const toolOutputSchema = sqlToolOutputSchema(outputSchema);
    const readOnly = query.readOnly ?? !WRITE_VERBS.has(query.verb);
    if (READ_VERBS.has(query.verb) && !readOnly) {
      throw new ConnectorError(
        'connector.SQL_WRITE_IN_READ_ONLY',
        `${label} uses the read verb "${query.verb}" but is not read-only; use a write verb`,
      );
    }
    if (WRITE_VERBS.has(query.verb) && readOnly) {
      throw new ConnectorError(
        'connector.SQL_WRITE_IN_READ_ONLY',
        `${label} uses the write verb "${query.verb}" but is declared read-only`,
      );
    }
    const scanned = scanSql(query.sql, label);
    if (readOnly) assertReadOnlySql(scanned, label);
    validatePlaceholders(query, scanned, label);

    const timeoutMs = checkedTimeout(query.timeoutMs, defaultTimeout, label);
    const maxRows = checkedInteger(query.maxRows, defaultMaxRows, 1, 10_000, `${label} maxRows`);
    const columns = normalizeColumns(query.columns, label);
    const name = sqlToolName(namespace, query.verb, query.name);
    const description = describeConnector(
      query.description,
      `Named SQL ${query.verb} query "${query.name}" (${options.dialect})`,
    );

    const execute = async (
      rawInput: unknown,
      execOptions: ConnectorExecuteOptions = {},
    ): Promise<SqlToolResult> => {
      if (!readOnly && !allowWrites) {
        throw new ConnectorError(
          'connector.SQL_WRITES_DISABLED',
          `${label} is a write and writes are disabled for this import`,
        );
      }
      if (execOptions.signal?.aborted) {
        throw new ConnectorError('connector.ABORTED', `${label} was aborted`);
      }
      const input = parseInput(inputSchema, rawInput, label);
      const params = bindParameters(input, scanned, query.params, label);
      const runner = readOnly ? (options.readOnlyRunner ?? options.runner) : options.runner;
      let result: SqlRunnerResult;
      try {
        result = await runner.run({
          name: query.name,
          sql: scanned.sql,
          params,
          timeoutMs,
          maxRows,
          readOnly,
          ...(execOptions.signal ? { signal: execOptions.signal } : {}),
        });
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError('connector.SQL_EXECUTION_FAILED', `${label} failed`, {
          cause: error,
        });
      }
      if (!result || !Array.isArray(result.rows) || !result.rows.every(isPlainObject)) {
        throw new ConnectorError(
          'connector.SQL_EXECUTION_FAILED',
          `${label} runner returned an invalid result`,
        );
      }
      const rows = result.rows;
      const truncated = result.truncated === true || rows.length > maxRows;
      const cappedRows = rows.slice(0, maxRows);
      const foundColumns = resultColumns(cappedRows);
      const returnedColumns = columns ?? foundColumns;
      const omittedColumns = foundColumns.filter((column) => !returnedColumns.includes(column));
      const validated = cappedRows.map((row) =>
        parseOutput(outputSchema, projectRow(row, returnedColumns, columns !== undefined), label),
      );
      return {
        rows: validated,
        rowCount: validated.length,
        truncated,
        columns: returnedColumns,
        omittedColumns,
      };
    };

    tools.push({
      kind: 'sql',
      dialect: options.dialect,
      query,
      name,
      version: '0.0.0',
      owner: `connector:${namespace}`,
      description,
      examples: normalizeExamples(query.examples, label),
      inputSchema,
      outputSchema: toolOutputSchema,
      access: readOnly ? 'read' : 'write',
      risk: readOnly ? 'low' : 'high',
      undo: readOnly ? 'free' : 'none',
      enabled: readOnly || allowWrites,
      complete: true,
      idempotent: readOnly,
      scopes: normalizeScopes(
        query.scopes,
        [readOnly ? 'connector:read' : 'connector:write'],
        label,
      ),
      timeoutMs,
      execute,
    });
  }

  assertUniqueNames(
    tools.map((tool) => tool.name),
    'this SQL import',
  );
  return tools;
}

export interface PostgresSqlRunnerOptions {
  url: string;
  /**
   * Set when this pool uses the operator-created read-only role. The runner
   * also sets every read transaction `READ ONLY`; that is defence in depth, not
   * a substitute for a role without INSERT/UPDATE/DELETE grants.
   */
  readOnly?: boolean;
  maxConnections?: number;
  /** Default statement timeout for requests that omit one (default 5000 ms). */
  timeoutMs?: number;
  /** Default row cap for requests that omit one (default 100). */
  maxRows?: number;
}

const RETRYABLE_PG_CODES = new Set([
  '40001',
  '40P01',
  '57P01',
  '57P02',
  '57P03',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);

function wrapReadQuery(sqlText: string, maxRows: number): string {
  const body = sqlText.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (\n${body}\n) AS connector_rows LIMIT ${maxRows + 1}`;
}

/**
 * Postgres runner with a per-query statement timeout and row cap. Reads are
 * wrapped in a subquery with `LIMIT maxRows + 1` (so truncation is detectable);
 * every transaction is explicitly `READ ONLY` for read queries. SQL text and
 * parameters never appear in thrown error messages.
 */
export class PostgresSqlRunner implements SqlRunner {
  private readonly sql: postgres.Sql;
  private readonly readOnly: boolean;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRows: number;

  constructor(options: PostgresSqlRunnerOptions) {
    if (!options.url || !/^postgres(ql)?:\/\//.test(options.url)) {
      throw new ConnectorError(
        'connector.SQL_CONNECTION_INVALID',
        'PostgresSqlRunner needs a postgres:// or postgresql:// connection URL',
      );
    }
    this.readOnly = options.readOnly === true;
    this.defaultTimeoutMs = checkedTimeout(options.timeoutMs, 5_000, 'Postgres');
    this.defaultMaxRows = checkedInteger(options.maxRows, 100, 1, 10_000, 'Postgres maxRows');
    this.sql = postgres(options.url, {
      max: checkedInteger(options.maxConnections, 2, 1, 20, 'Postgres maxConnections'),
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  async run(request: SqlQueryRequest): Promise<SqlRunnerResult> {
    const readOnly = request.readOnly ?? true;
    if (this.readOnly && !readOnly) {
      throw new ConnectorError(
        'connector.SQL_READ_ONLY_RUNNER',
        `SQL query "${request.name}" is a write but this runner uses the read-only role`,
      );
    }
    if (request.signal?.aborted) {
      throw new ConnectorError('connector.ABORTED', `SQL query "${request.name}" was aborted`);
    }
    const maxRows = checkedInteger(
      request.maxRows,
      this.defaultMaxRows,
      1,
      10_000,
      'Postgres maxRows',
    );
    const timeoutMs = checkedTimeout(request.timeoutMs, this.defaultTimeoutMs, 'Postgres');
    const sqlText = readOnly ? wrapReadQuery(request.sql, maxRows) : request.sql;

    try {
      const rows = await this.sql.begin(async (tx) => {
        if (readOnly || this.readOnly) {
          await tx.unsafe('SET TRANSACTION READ ONLY');
        }
        await tx.unsafe(`SELECT set_config('statement_timeout', $1, true)`, [`${timeoutMs}ms`]);
        const result = await tx.unsafe(sqlText, (request.params ?? []) as never[]);
        return result as unknown as Array<Record<string, unknown>>;
      });
      return { rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
    } catch (error) {
      const code =
        typeof (error as { code?: unknown }).code === 'string'
          ? ((error as { code: string }).code as string)
          : undefined;
      if (code === '57014') {
        throw new ConnectorError(
          'connector.SQL_TIMEOUT',
          `SQL query "${request.name}" timed out after ${timeoutMs}ms`,
          { retryable: true, cause: error, details: { code } },
        );
      }
      if (code === '25006') {
        throw new ConnectorError(
          'connector.SQL_WRITE_IN_READ_ONLY',
          `SQL query "${request.name}" tried to write through a read-only connection`,
          { cause: error, details: { code } },
        );
      }
      throw new ConnectorError(
        'connector.SQL_EXECUTION_FAILED',
        `SQL query "${request.name}" failed`,
        {
          retryable: RETRYABLE_PG_CODES.has(code ?? ''),
          cause: error,
          ...(code ? { details: { code } } : {}),
        },
      );
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
