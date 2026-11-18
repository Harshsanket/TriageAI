import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { importSqlTools, PostgresSqlRunner, sqlDialectSupport } from '../src/index.js';
import type { SqlQuery, SqlQueryRequest, SqlRunner, SqlRunnerResult } from '../src/index.js';

function mockRunner(result: SqlRunnerResult | ((request: SqlQueryRequest) => SqlRunnerResult)) {
  const calls: SqlQueryRequest[] = [];
  const runner: SqlRunner = {
    async run(request) {
      calls.push(request);
      return typeof result === 'function' ? result(request) : result;
    },
  };
  return { calls, runner };
}

function query(overrides: Partial<SqlQuery> = {}): SqlQuery {
  return {
    name: 'dealById',
    verb: 'get',
    sql: 'SELECT id, name FROM deals WHERE id = :id',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ id: z.string() }),
    ...overrides,
  };
}

describe('SQL connector import (15.T7)', () => {
  it('creates enabled read tools and keeps writes disabled by default', async () => {
    const { runner } = mockRunner({ rows: [{ id: 'd1' }] });
    const tools = importSqlTools({
      dialect: 'postgres',
      namespace: 'crm',
      runner,
      queries: [
        query(),
        query({
          name: 'createDeal',
          verb: 'create',
          sql: 'INSERT INTO deals (name) VALUES (:name) RETURNING id',
          inputSchema: z.object({ name: z.string() }),
          outputSchema: z.object({ id: z.string() }),
        }),
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual(['crm.get_deal_by_id', 'crm.create_deal']);
    expect(tools[0]).toMatchObject({
      access: 'read',
      risk: 'low',
      undo: 'free',
      enabled: true,
      complete: true,
      idempotent: true,
      timeoutMs: 5_000,
    });
    expect(tools[1]).toMatchObject({
      access: 'write',
      risk: 'high',
      undo: 'none',
      enabled: false,
      complete: true,
      idempotent: false,
    });
    await expect(tools[1]!.execute({ name: 'Acme' })).rejects.toMatchObject({
      code: 'connector.SQL_WRITES_DISABLED',
    });
  });

  it('rewrites :name placeholders and binds tool input', async () => {
    const { calls, runner } = mockRunner({
      rows: [{ id: 'd1', name: 'Acme' }],
    });
    const [tool] = importSqlTools({
      dialect: 'postgres',
      runner,
      queries: [
        query({
          sql: 'SELECT id, name FROM deals WHERE id = :id AND status = :status;',
          inputSchema: z.object({ id: z.string(), status: z.string() }),
          outputSchema: z.object({ id: z.string(), name: z.string() }),
          columns: ['id', 'name'],
        }),
      ],
    });

    const result = await tool!.execute({ id: 'd1', status: 'open' });

    expect(calls[0]).toMatchObject({
      name: 'dealById',
      sql: 'SELECT id, name FROM deals WHERE id = $1 AND status = $2',
      params: ['d1', 'open'],
      timeoutMs: 5_000,
      maxRows: 100,
      readOnly: true,
    });
    expect(result).toEqual({
      rows: [{ id: 'd1', name: 'Acme' }],
      rowCount: 1,
      truncated: false,
      columns: ['id', 'name'],
      omittedColumns: [],
    });
    expect(tool!.outputSchema.safeParse(result).success).toBe(true);
  });

  it('binds positional $n placeholders through declared input paths', async () => {
    const { calls, runner } = mockRunner({ rows: [] });
    const [tool] = importSqlTools({
      dialect: 'postgres',
      runner,
      queries: [
        query({
          sql: 'SELECT id FROM deals WHERE id = $1::text AND owner = $2',
          params: ['deal.id', 'owner'],
          inputSchema: z.object({
            deal: z.object({ id: z.string() }),
            owner: z.string(),
          }),
        }),
      ],
    });

    await tool!.execute({ deal: { id: 'd1' }, owner: 'u1' });

    expect(calls[0]?.sql).toBe('SELECT id FROM deals WHERE id = $1::text AND owner = $2');
    expect(calls[0]?.params).toEqual(['d1', 'u1']);
  });

  it('caps rows and reports truncation even when the runner over-returns', async () => {
    const { runner } = mockRunner({
      rows: [{ id: '1' }, { id: '2' }, { id: '3' }],
    });
    const [tool] = importSqlTools({
      dialect: 'postgres',
      runner,
      maxRows: 2,
      queries: [query({ sql: 'SELECT id FROM deals', inputSchema: z.object({}) })],
    });

    const result = await tool!.execute({});

    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.rows).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('drops columns outside the allowlist and reports them', async () => {
    const { runner } = mockRunner({
      rows: [{ id: 'd1', name: 'Acme', internal_note: 'secret' }],
    });
    const [tool] = importSqlTools({
      dialect: 'postgres',
      runner,
      queries: [
        query({
          sql: 'SELECT * FROM deals',
          columns: ['id', 'name'],
          outputSchema: z.object({ id: z.string(), name: z.string() }),
        }),
      ],
    });

    const result = await tool!.execute({ id: 'd1' });

    expect(result.rows).toEqual([{ id: 'd1', name: 'Acme' }]);
    expect(result.columns).toEqual(['id', 'name']);
    expect(result.omittedColumns).toEqual(['internal_note']);
  });

  it('uses the read-only runner for reads and the main runner for enabled writes', async () => {
    const read = mockRunner({ rows: [] });
    const write = mockRunner({ rows: [{ id: 'new' }] });
    const tools = importSqlTools({
      dialect: 'postgres',
      runner: write.runner,
      readOnlyRunner: read.runner,
      allowWrites: true,
      queries: [
        query({ sql: 'SELECT id FROM deals', inputSchema: z.object({}) }),
        query({
          name: 'createDeal',
          verb: 'create',
          sql: 'INSERT INTO deals DEFAULT VALUES RETURNING id',
          inputSchema: z.object({}),
        }),
      ],
    });

    await tools[0]!.execute({});
    await tools[1]!.execute({});

    expect(read.calls).toHaveLength(1);
    expect(write.calls).toHaveLength(1);
    expect(write.calls[0]?.readOnly).toBe(false);
    expect(tools[1]?.enabled).toBe(true);
  });

  it('rejects interpolation, multi-statement SQL and writes in read-only queries', () => {
    const { runner } = mockRunner({ rows: [] });
    const base = { dialect: 'postgres' as const, runner };

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query({ sql: 'SELECT * FROM deals WHERE id = ${id}' })],
      }),
    ).toThrow(/must not use string interpolation/);

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query({ sql: 'SELECT 1; SELECT 2' })],
      }),
    ).toThrow(/exactly one statement/);

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query({ sql: 'UPDATE deals SET name = :name' })],
      }),
    ).toThrow(/read-only but its SQL uses "update"/);

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query({ sql: 'SELECT id FROM deals FOR UPDATE' })],
      }),
    ).toThrow(/row-locking clause/);
  });

  it('validates placeholder bindings and input/output schemas', async () => {
    const { runner } = mockRunner({ rows: [{ id: 7 }] });
    const base = { dialect: 'postgres' as const, runner };

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query({ sql: 'SELECT id FROM deals WHERE id = $1', params: [] })],
      }),
    ).toThrow(/uses \$1\.\.\$1 but declares 0 params/);

    expect(() =>
      importSqlTools({
        ...base,
        queries: [
          query({
            sql: 'SELECT id FROM deals WHERE id = :id AND owner = $1',
            params: ['owner'],
          }),
        ],
      }),
    ).toThrow(/mixes :name and \$n placeholders/);

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query({ sql: 'SELECT id FROM deals WHERE id = :missing' })],
      }),
    ).toThrow(/placeholder ":missing" is not a field/);

    const [tool] = importSqlTools({
      ...base,
      queries: [
        query({
          sql: 'SELECT id FROM deals WHERE id = :id',
          inputSchema: z.object({ id: z.string() }),
        }),
      ],
    });
    await expect(tool!.execute({})).rejects.toMatchObject({ code: 'connector.INPUT_INVALID' });
    await expect(tool!.execute({ id: 'd1' })).rejects.toMatchObject({
      code: 'connector.OUTPUT_INVALID',
    });
  });

  it('refuses contradictory read-only declarations and duplicate names', () => {
    const { runner } = mockRunner({ rows: [] });
    const base = { dialect: 'postgres' as const, runner };

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query({ verb: 'update', readOnly: true, sql: 'UPDATE deals SET name = name' })],
      }),
    ).toThrow(/declared read-only/);

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query({ verb: 'get', readOnly: false, sql: 'SELECT id FROM deals' })],
      }),
    ).toThrow(/is not read-only; use a write verb/);

    expect(() =>
      importSqlTools({
        ...base,
        queries: [query(), query({ name: 'getDealById' })],
      }),
    ).toThrow(/more than once/);
  });

  it('returns a clear unsupported result for dialects without a runner', () => {
    const { runner } = mockRunner({ rows: [] });
    expect(sqlDialectSupport('mysql')).toMatchObject({
      supported: false,
      dialect: 'mysql',
    });
    expect(() =>
      importSqlTools({
        dialect: 'mysql',
        runner,
        queries: [query()],
      }),
    ).toThrow(/only Postgres has a built-in runner/);
  });

  it('configures the Postgres runner and refuses writes on a read-only runner', async () => {
    expect(() => new PostgresSqlRunner({ url: 'mysql://localhost/db' })).toThrow(/postgres/);
    expect(() => new PostgresSqlRunner({ url: 'postgres://localhost/db', maxRows: 0 })).toThrow(
      /maxRows/,
    );

    const runner = new PostgresSqlRunner({
      url: 'postgres://user:pass@localhost:5432/triageai',
      readOnly: true,
      timeoutMs: 250,
      maxRows: 5,
    });
    await expect(
      runner.run({
        name: 'createDeal',
        sql: 'INSERT INTO deals DEFAULT VALUES',
        params: [],
        readOnly: false,
      }),
    ).rejects.toMatchObject({ code: 'connector.SQL_READ_ONLY_RUNNER' });
    await runner.close();
  });
});
