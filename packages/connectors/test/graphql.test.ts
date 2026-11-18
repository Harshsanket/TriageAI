import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { importGraphqlTools } from '../src/index.js';
import type { ConnectorFetch, GraphqlOperation } from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recorder(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const request: ConnectorFetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(body, status);
  };
  return { calls, request };
}

function operation(overrides: Partial<GraphqlOperation> = {}): GraphqlOperation {
  return {
    name: 'getDeal',
    kind: 'query',
    document: 'query getDeal($id: ID!) { deal(id: $id) { id status } }',
    inputSchema: z.object({ id: z.string() }),
    outputSchema: z.object({ deal: z.object({ id: z.string(), status: z.string() }) }),
    ...overrides,
  };
}

describe('GraphQL connector import (15.T7)', () => {
  it('enables complete queries and leaves mutations disabled, high-risk and undo:none', () => {
    const { request } = recorder({ data: {} });
    const tools = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      namespace: 'crm',
      request,
      operations: [
        operation(),
        operation({
          name: 'createDeal',
          kind: 'mutation',
          document: 'mutation createDeal($name: String!) { createDeal(name: $name) { id } }',
          inputSchema: z.object({ name: z.string() }),
          outputSchema: z.object({ createDeal: z.object({ id: z.string() }) }),
        }),
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual(['crm.get_deal', 'crm.create_deal']);
    expect(tools[0]).toMatchObject({
      access: 'read',
      risk: 'low',
      undo: 'free',
      enabled: true,
      complete: true,
      idempotent: true,
      timeoutMs: 30_000,
      allowedHosts: ['crm.example'],
    });
    expect(tools[1]).toMatchObject({
      access: 'write',
      risk: 'high',
      undo: 'none',
      enabled: false,
      complete: true,
      idempotent: false,
    });
  });

  it('keeps mutation execution disabled until writes are explicitly enabled', async () => {
    const { request } = recorder({ data: { createDeal: { id: 'd1' } } });
    const mutation = operation({
      name: 'createDeal',
      kind: 'mutation',
      document: 'mutation createDeal($name: String!) { createDeal(name: $name) { id } }',
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ createDeal: z.object({ id: z.string() }) }),
    });

    const [disabled] = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      request,
      operations: [mutation],
    });
    await expect(disabled!.execute({ name: 'Acme' })).rejects.toMatchObject({
      code: 'connector.GRAPHQL_WRITES_DISABLED',
    });

    const [enabled] = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      request,
      allowWrites: true,
      operations: [mutation],
    });
    expect(enabled).toMatchObject({ enabled: true, access: 'write', risk: 'high' });
    await expect(enabled!.execute({ name: 'Acme' })).resolves.toEqual({
      createDeal: { id: 'd1' },
    });
  });

  it('executes with the injected request, mapped variables and headers', async () => {
    const { calls, request } = recorder({
      data: { deal: { id: 'd1', status: 'won' } },
    });
    const [tool] = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      namespace: 'crm',
      headers: { 'X-Tenant': 'acme' },
      request,
      operations: [
        operation({
          headers: { 'X-Operation': 'deal' },
          variables: { dealId: 'deal.id' },
          inputSchema: z.object({ deal: z.object({ id: z.string() }) }),
        }),
      ],
    });

    const result = await tool!.execute({ deal: { id: 'd1' } });

    expect(result).toEqual({ deal: { id: 'd1', status: 'won' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://crm.example/graphql');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-tenant': 'acme',
      'x-operation': 'deal',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      query: 'query getDeal($id: ID!) { deal(id: $id) { id status } }',
      variables: { dealId: 'd1' },
      operationName: 'getDeal',
    });
  });

  it('marks operations without both schemas incomplete and refuses to execute them', async () => {
    const { request } = recorder({ data: { deals: [] } });
    const [tool] = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      request,
      operations: [
        {
          name: 'searchDeals',
          kind: 'query',
          document: 'query searchDeals { deals { id } }',
        },
      ],
    });

    expect(tool).toMatchObject({
      name: 'graphql.search_deals',
      complete: false,
      enabled: false,
    });
    expect(tool?.inputSchema.safeParse({ free: 'form' }).success).toBe(true);
    await expect(tool!.execute({})).rejects.toMatchObject({
      code: 'connector.CONTRACT_INCOMPLETE',
    });
  });

  it('returns GraphQL errors as typed, non-retryable failures', async () => {
    const { request } = recorder({
      errors: [{ message: 'deal not found', path: ['deal'] }],
    });
    const [tool] = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      request,
      operations: [operation()],
    });

    await expect(tool!.execute({ id: 'missing' })).rejects.toMatchObject({
      code: 'connector.GRAPHQL_ERRORS',
      retryable: false,
    });
  });

  it('classifies 5xx responses as retryable HTTP failures', async () => {
    const { request } = recorder({ error: 'down' }, 503);
    const [tool] = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      request,
      operations: [operation()],
    });

    await expect(tool!.execute({ id: 'd1' })).rejects.toMatchObject({
      code: 'connector.GRAPHQL_HTTP_ERROR',
      retryable: true,
      details: { status: 503 },
    });
  });

  it('validates output against the declared schema', async () => {
    const { request } = recorder({ data: { deal: { id: 42, status: 'won' } } });
    const [tool] = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      request,
      operations: [operation()],
    });

    await expect(tool!.execute({ id: 'd1' })).rejects.toMatchObject({
      code: 'connector.OUTPUT_INVALID',
      details: [{ path: 'deal.id', message: expect.any(String) }],
    });
  });

  it('times out a request and reports it as retryable', async () => {
    const request: ConnectorFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const [tool] = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      request,
      timeoutMs: 10,
      operations: [operation()],
    });

    await expect(tool!.execute({ id: 'd1' })).rejects.toMatchObject({
      code: 'connector.GRAPHQL_TIMEOUT',
      retryable: true,
    });
  });

  it('rejects kind mismatches, interpolation and duplicate derived names', () => {
    const { request } = recorder({ data: {} });
    expect(() =>
      importGraphqlTools({
        endpoint: 'https://crm.example/graphql',
        request,
        operations: [operation({ kind: 'mutation' })],
      }),
    ).toThrow(/declared as a mutation but its document is a query/);

    expect(() =>
      importGraphqlTools({
        endpoint: 'https://crm.example/graphql',
        request,
        operations: [operation({ name: 'listDeals' })],
      }),
    ).toThrow(/does not match the document operation "getDeal"/);

    expect(() =>
      importGraphqlTools({
        endpoint: 'https://crm.example/graphql',
        request,
        operations: [
          operation({
            document: 'query getDeal { deal(id: "${id}") { id } }',
          }),
        ],
      }),
    ).toThrow(/must not use string interpolation/);

    expect(() =>
      importGraphqlTools({
        endpoint: 'https://crm.example/graphql',
        request,
        operations: [operation(), operation()],
      }),
    ).toThrow(/produces the tool name "graphql.get_deal" more than once/);
  });

  it('maps verbs through the fixed table', () => {
    const { request } = recorder({ data: {} });
    const output = z.object({ ok: z.boolean() });
    const tools = importGraphqlTools({
      endpoint: 'https://crm.example/graphql',
      namespace: 'crm',
      request,
      operations: [
        operation({ name: 'listDeals', document: 'query listDeals { deals { id } }' }),
        operation({ name: 'deleteStats', document: 'query deleteStats { stats { id } }' }),
        operation({
          name: 'sendEmail',
          kind: 'mutation',
          document: 'mutation sendEmail { sendEmail { ok } }',
          outputSchema: output,
        }),
        operation({
          name: 'refreshToken',
          kind: 'mutation',
          document: 'mutation refreshToken { refreshToken { ok } }',
          outputSchema: output,
        }),
      ],
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      'crm.list_deals',
      'crm.get_delete_stats',
      'crm.send_email',
      'crm.run_refresh_token',
    ]);
  });
});
