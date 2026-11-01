import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Kernel } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const TITLE = `Phase 20 grocery ${Date.now()}`;

const CSV = [
  'date,description,amount,direction,balance,account',
  '2026-09-02,STARBUCKS,4.50,out,995.50,1234567890',
  '2026-09-05,WHOLE FOODS,120.00,out,875.50,1234567890',
  '2026-09-10,PAYROLL,2000.00,in,2875.50,1234567890',
].join('\n');

async function importDataset(
  app: FastifyInstance,
  title: string,
  closingBalance: number,
  pinned = false,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/data-extract/datasets',
    payload: {
      title,
      content: CSV,
      mediaType: 'text/csv',
      confirmMapping: true,
      pinned,
      openingBalance: 1000,
      closingBalance,
      sourceLabel: 'fixture',
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as {
    dataset: { id: string; status: string; reviewReason: string | null };
    inserted: number;
    duplicates: number;
  };
}

describeIfDb('structured extraction (phase 20)', () => {
  let app: FastifyInstance & { kernel?: Kernel };
  let database: PostgresDatabase;
  let dir: string;
  let readyId = '';
  let reviewId = '';

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'triageai-extract-'));
    const configPath = path.join(dir, 'triage.config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        profile: 'core',
        queue: { adapter: 'pg-queue', pollIntervalMs: 50 },
        modules: { 'data-extract': { enabled: true } },
        capabilities: {},
      }),
    );
    database = new PostgresDatabase(DATABASE_URL);
    app = (await buildApp({
      quiet: true,
      configPath,
      setup: false,
      authMode: 'disabled',
    })) as FastifyInstance & { kernel?: Kernel };
  }, 60_000);

  afterAll(async () => {
    await database.query(
      `DELETE FROM mod_data_extract.extracted_datasets WHERE title LIKE $1 OR title = $2`,
      [`${TITLE}%`, `${TITLE} tampered`],
    );
    await app.close();
    await database.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('imports a bank CSV, reconciles, dedupes and answers with SQL', async () => {
    const imported = await importDataset(app, TITLE, 2875.5, true);
    readyId = imported.dataset.id;
    expect(imported.dataset.status).toBe('ready');
    expect(imported.inserted).toBe(3);

    const duplicateRows = await app.inject({
      method: 'POST',
      url: '/api/v1/data-extract/datasets',
      payload: {
        title: `${TITLE} duplicates`,
        content: [
          'date,description,amount,direction,account',
          '2026-09-02,STARBUCKS,4.50,out,1234567890',
          '2026-09-02,STARBUCKS,4.50,out,1234567890',
        ].join('\n'),
        mediaType: 'text/csv',
        confirmMapping: true,
      },
    });
    expect(duplicateRows.statusCode).toBe(200);
    const duplicateBody = duplicateRows.json() as {
      dataset: { id: string };
      inserted: number;
      duplicates: number;
    };
    expect(duplicateBody.inserted).toBe(1);
    expect(duplicateBody.duplicates).toBe(1);
    await database.query(`DELETE FROM mod_data_extract.extracted_datasets WHERE id = $1`, [
      duplicateBody.dataset.id,
    ]);

    const summaryRes = await app.inject({
      method: 'GET',
      url: `/api/v1/data-extract/datasets/${readyId}/summary`,
    });
    expect(summaryRes.statusCode).toBe(200);
    const summary = summaryRes.json() as {
      totals: { in: number; out: number; net: number };
      byCategory: Array<{ category: string; total: number }>;
    };
    expect(summary.totals.in).toBe(2000);
    expect(summary.totals.out).toBe(124.5);
    expect(summary.totals.net).toBe(1875.5);
    expect(summary.byCategory.find((row) => row.category === 'Groceries')?.total).toBe(120);

    const tool = await app.kernel!.tools.invoke(
      'data_extract.query_dataset',
      { datasetId: readyId, category: 'Groceries' },
      {
        runId: 'run-test',
        stepId: 'step-test',
        actorId: 'local-developer',
        grantedScopes: ['data_extract:read'],
        egressClass: 'restricted',
        hosted: false,
        org: { ownsEmail: () => false },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
    );
    expect(tool.ok).toBe(true);
    if (tool.ok) {
      expect((tool.data as { total: number }).total).toBe(120);
      expect((tool.data as { query: string }).query).toContain('extracted_rows');
    }
    const summaryRoute = app
      .kernel!.routes()
      .find(
        (route) =>
          route.method === 'GET' && route.url === '/api/v1/data-extract/datasets/:id/summary',
      );
    await expect(
      summaryRoute!.handler({
        method: 'GET',
        url: '/api/v1/data-extract/datasets/:id/summary',
        params: { id: readyId },
        query: {},
        body: null,
        actorId: 'other-agent',
        role: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'data_extract.FORBIDDEN' });

    const wildcard = await app.kernel!.tools.invoke(
      'data_extract.query_dataset',
      { datasetId: readyId, merchantContains: '%', aggregate: 'count' },
      {
        runId: 'run-test',
        stepId: 'step-test',
        actorId: 'local-developer',
        grantedScopes: ['data_extract:read'],
        egressClass: 'restricted',
        hosted: false,
        org: { ownsEmail: () => false },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
    );
    expect(wildcard.ok).toBe(true);
    if (wildcard.ok) expect((wildcard.data as { total: number }).total).toBe(0);

    const hosted = await app.kernel!.tools.invoke(
      'data_extract.query_dataset',
      { datasetId: readyId, category: 'Groceries' },
      {
        runId: 'run-test',
        stepId: 'step-test',
        actorId: 'local-developer',
        grantedScopes: ['data_extract:read'],
        egressClass: 'restricted',
        hosted: true,
        org: { ownsEmail: () => false },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      },
    );
    expect(hosted.ok).toBe(false);

    const rows = await database.query<{ fields: { account: string } }>(
      `SELECT fields FROM mod_data_extract.extracted_rows WHERE dataset_id = $1 LIMIT 1`,
      [readyId],
    );
    expect(rows[0]?.fields.account).toBe('****7890');

    const dashboard = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard' });
    const body = dashboard.json() as {
      pinnedDatasets: Array<{ id: string }>;
    };
    expect(body.pinnedDatasets.map((dataset) => dataset.id)).toContain(readyId);
  });

  it('keeps a statement that does not reconcile out of charts', async () => {
    const tampered = await importDataset(app, `${TITLE} tampered`, 2800, true);
    reviewId = tampered.dataset.id;
    expect(tampered.dataset.status).toBe('needs_review');
    expect(tampered.dataset.reviewReason).toMatch(/does not reconcile/);

    const dashboard = await app.inject({ method: 'GET', url: '/api/v1/system/dashboard' });
    const body = dashboard.json() as { pinnedDatasets: Array<{ id: string }> };
    expect(body.pinnedDatasets.map((dataset) => dataset.id)).not.toContain(reviewId);
  });
});
