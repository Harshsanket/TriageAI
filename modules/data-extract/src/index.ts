/**
 * data-extract module (Phase 20.3–20.5, ADR-0052): documents with records become
 * typed, queryable rows. Deterministic parsing first; financial datasets are
 * `restricted` and numbers are answered by SQL, never by a model reading rows.
 */
import { createHash } from 'node:crypto';

import { ulid } from 'ulid';
import { z } from 'zod';

import {
  DatasetQueryResultSchema,
  DatasetQuerySchema,
  DatasetRuleSchema,
  DatasetSummarySchema,
  ExtractedDatasetDtoSchema,
  ExtractedRowDtoSchema,
  ImportDatasetRequestSchema,
  ImportDatasetResponseSchema,
  type DatasetQuery,
  type ExtractionProfile,
  type ExtractedDatasetDto,
} from '@triageai/contracts';
import { AppError, classifySend } from '@triageai/kernel';
import type { KernelContext, TriageModule } from '@triageai/kernel';
import { extractText } from '@triageai/rag';

import {
  categoryFor,
  inferMapping,
  mappingSignature,
  maskAccount,
  normalizeDate,
  parseAmount,
  parseCsv,
  parseStatementText,
  signedAmount,
  type TransactionFields,
} from './parse.js';

const configSchema = z
  .object({
    defaultSensitivity: z
      .enum(['public', 'internal', 'restricted', 'secret'])
      .default('restricted'),
    collection: z.string().default('data_extract_datasets'),
  })
  .strict();

interface DatasetRow {
  [key: string]: unknown;
  id: string;
  title: string;
  profile: ExtractionProfile;
  status: 'ready' | 'needs_review' | 'failed';
  source_id: string | null;
  source_label: string;
  row_count: number;
  pinned: boolean;
  sensitivity: 'public' | 'internal' | 'restricted' | 'secret';
  mapping: Record<string, string>;
  review_reason: string | null;
  owner_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RowRow {
  [key: string]: unknown;
  id: string;
  dataset_id: string;
  fields: Record<string, unknown>;
  category: string | null;
  category_source: 'rule' | 'suggested' | 'user' | null;
  created_at: Date | string;
}

const MIGRATIONS = [
  {
    id: '0001-data-extract-tables',
    sql: `
      CREATE TABLE IF NOT EXISTS extracted_datasets (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        profile TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready'
          CHECK (status IN ('ready','needs_review','failed')),
        source_id TEXT,
        source_label TEXT NOT NULL DEFAULT 'upload',
        row_count INT NOT NULL DEFAULT 0,
        pinned BOOLEAN NOT NULL DEFAULT false,
        sensitivity TEXT NOT NULL DEFAULT 'restricted'
          CHECK (sensitivity IN ('public','internal','restricted','secret')),
        mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
        review_reason TEXT,
        owner_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS extracted_datasets_source
        ON extracted_datasets (source_id) WHERE source_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS extracted_datasets_ready
        ON extracted_datasets (status, pinned, updated_at DESC);
      CREATE TABLE IF NOT EXISTS extracted_rows (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL REFERENCES extracted_datasets(id) ON DELETE CASCADE,
        fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        category TEXT,
        category_source TEXT CHECK (category_source IN ('rule','suggested','user')),
        dedupe_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (dataset_id, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS extracted_rows_dataset
        ON extracted_rows (dataset_id, created_at);
      CREATE TABLE IF NOT EXISTS extraction_mappings (
        signature TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        mapping JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS extraction_rules (
        id TEXT PRIMARY KEY,
        keyword TEXT NOT NULL,
        category TEXT NOT NULL,
        owner_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (keyword, category)
      );
    `,
    dropSql: `
      DROP TABLE IF EXISTS extraction_rules;
      DROP TABLE IF EXISTS extraction_mappings;
      DROP TABLE IF EXISTS extracted_rows;
      DROP TABLE IF EXISTS extracted_datasets;
    `,
  },
];

const datasetDto = (row: DatasetRow): ExtractedDatasetDto =>
  ExtractedDatasetDtoSchema.parse({
    id: row.id,
    title: row.title,
    profile: row.profile,
    status: row.status,
    sourceId: row.source_id,
    sourceLabel: row.source_label,
    rowCount: Number(row.row_count ?? 0),
    pinned: row.pinned,
    sensitivity: row.sensitivity,
    mapping: row.mapping,
    reviewReason: row.review_reason,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });

const rowDto = (row: RowRow) =>
  ExtractedRowDtoSchema.parse({
    id: row.id,
    datasetId: row.dataset_id,
    fields: row.fields,
    category: row.category,
    categorySource: row.category_source,
    createdAt: new Date(row.created_at).toISOString(),
  });

export const dataExtractModule: TriageModule = {
  id: 'data-extract',
  version: '0.1.0',
  capabilities: ['embedder', 'vectorStore'],
  permissions: {
    storage: { schema: true },
    routes: [
      { method: 'DELETE', path: '/api/v1/data-extract/datasets/:id' },
      { method: 'GET', path: '/api/v1/data-extract/datasets' },
      { method: 'GET', path: '/api/v1/data-extract/datasets/:id' },
      { method: 'GET', path: '/api/v1/data-extract/datasets/:id/rows' },
      { method: 'GET', path: '/api/v1/data-extract/datasets/:id/summary' },
      { method: 'PATCH', path: '/api/v1/data-extract/datasets/:id' },
      { method: 'POST', path: '/api/v1/data-extract/datasets' },
      { method: 'POST', path: '/api/v1/data-extract/datasets/:id/confirm' },
      { method: 'POST', path: '/api/v1/data-extract/rules' },
    ],
    events: { publish: [], subscribe: ['kb.source.ingested'] },
    capabilities: { consume: ['embedder', 'vectorStore'], provide: [] },
    stages: [],
    workflows: [],
    evals: [],
    tools: ['data_extract.query_dataset'],
    knowledge: { read: ['*'], write: ['*'] },
  },
  dependsOn: {
    capabilities: [
      { capability: 'embedder', optional: true },
      { capability: 'vectorStore', optional: true },
    ],
  },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['extracted_datasets', 'extracted_rows', 'extraction_mappings', 'extraction_rules'],
  manifest: {
    routes: [{ path: '/data-extract', title: 'Datasets' }],
    nav: [{ label: 'Datasets', order: 35, path: '/data-extract' }],
    background: [],
  },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: 'deterministic extraction + SQL queries' }),
    onUninstall: async ({ options, knowledge }) => {
      const collection =
        typeof options.collection === 'string' ? options.collection : 'data_extract_datasets';
      await knowledge.deleteCollection(collection);
    },
  },
  register(ctx) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const collection = options.collection;

    const loadDataset = async (id: string): Promise<DatasetRow | undefined> => {
      const rows = await ctx.database.query<DatasetRow>(
        `SELECT * FROM extracted_datasets WHERE id = $1`,
        [id],
      );
      return rows[0];
    };

    const rules = async (ownerId: string | null) =>
      (
        await ctx.database.query<{ keyword: string; category: string }>(
          `SELECT keyword, category FROM extraction_rules
            ${ownerId ? 'WHERE owner_id IS NULL OR owner_id = $1' : 'WHERE owner_id IS NULL'}
            ORDER BY created_at`,
          ownerId ? [ownerId] : [],
        )
      ).map((row) => ({ keyword: row.keyword, category: row.category }));

    const insertTransactionRows = async (
      datasetId: string,
      rows: TransactionFields[],
      ownerId: string | null,
    ) => {
      const ruleList = await rules(ownerId);
      let inserted = 0;
      let duplicates = 0;
      for (const row of rows) {
        const category = row.category
          ? { category: row.category, source: 'user' as const }
          : categoryFor(row.description, ruleList);
        const fields = {
          date: row.date,
          description: row.description,
          amount: row.amount,
          currency: row.currency,
          direction: row.direction,
          balance: row.balance,
          category: category?.category ?? null,
          account: maskAccount(row.account),
          merchant: row.merchant,
        };
        const dedupeKey = createHash('sha256')
          .update(
            [
              fields.account ?? '',
              fields.date,
              fields.amount,
              fields.description.toLowerCase(),
            ].join('|'),
          )
          .digest('hex');
        const result = await ctx.database.query<{ id: string }>(
          `INSERT INTO extracted_rows (id, dataset_id, fields, category, category_source, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (dataset_id, dedupe_key) DO NOTHING
           RETURNING id`,
          [
            ulid(),
            datasetId,
            fields,
            category?.category ?? null,
            category?.source ?? null,
            dedupeKey,
          ],
        );
        if (result.length > 0) inserted += 1;
        else duplicates += 1;
      }
      return { inserted, duplicates };
    };

    const insertGenericRows = async (datasetId: string, rows: Array<Record<string, string>>) => {
      let inserted = 0;
      let duplicates = 0;
      for (const row of rows) {
        const dedupeKey = createHash('sha256').update(JSON.stringify(row)).digest('hex');
        const result = await ctx.database.query<{ id: string }>(
          `INSERT INTO extracted_rows (id, dataset_id, fields, dedupe_key)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (dataset_id, dedupe_key) DO NOTHING
           RETURNING id`,
          [ulid(), datasetId, row, dedupeKey],
        );
        if (result.length > 0) inserted += 1;
        else duplicates += 1;
      }
      return { inserted, duplicates };
    };

    const embedSummary = async (dataset: DatasetRow): Promise<void> => {
      const embedder = ctx.capabilities.embedder;
      const vectorStore = ctx.capabilities.vectorStore;
      if (!embedder || !vectorStore) return;
      const text = `Dataset ${dataset.title} (${dataset.profile}) with ${dataset.row_count} rows.`;
      try {
        const embedded = await embedder.embed([text]);
        await vectorStore.upsert([
          {
            id: `${dataset.id}:summary`,
            collection,
            documentId: dataset.id,
            text,
            metadata: {
              datasetId: dataset.id,
              title: dataset.title,
              profile: dataset.profile,
              sensitivity: dataset.sensitivity,
              approved: true,
              sourceEnabled: true,
            },
            embedding: embedded.vectors[0] as number[],
          },
        ]);
      } catch {
        // Summaries are an enhancement; extraction itself must still succeed.
      }
    };

    const importDataset = async (
      raw: z.input<typeof ImportDatasetRequestSchema>,
      ownerId: string | null,
    ) => {
      const input = ImportDatasetRequestSchema.parse(raw);
      const decoded =
        input.contentEncoding === 'base64'
          ? new Uint8Array(Buffer.from(input.content, 'base64'))
          : new TextEncoder().encode(input.content);

      let text = input.content;
      if (input.mediaType === 'application/pdf') {
        text = extractText(decoded, 'application/pdf').text;
      } else if (input.mediaType.includes('spreadsheetml')) {
        text = extractText(
          decoded,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ).text;
      }

      const delimiter = input.mediaType === 'text/tab-separated-values' ? '\t' : ',';
      const csvRows = parseCsv(text, delimiter);
      const headers = Object.keys(csvRows[0] ?? {});
      const inferred = input.mapping ?? (headers.length > 0 ? inferMapping(headers) : {});
      const isStatement =
        input.profile === 'transactions' ||
        (!input.profile && Boolean(inferred.date && inferred.description && inferred.amount));
      const profile: ExtractionProfile =
        input.profile ?? (isStatement ? 'transactions' : 'generic-table');

      let transactions: TransactionFields[] = [];
      let genericRows: Array<Record<string, string>> = csvRows;
      let unparsed: string[] = [];
      if (profile === 'transactions') {
        if (csvRows.length > 0 && inferred.date && inferred.description && inferred.amount) {
          transactions = csvRows
            .map((row) => {
              const date = normalizeDate(row[inferred.date as string] ?? '');
              const amount = parseAmount(row[inferred.amount as string]);
              const description = row[inferred.description as string] ?? '';
              if (!date || amount === null || !description) return null;
              const directionValue = inferred.direction
                ? (row[inferred.direction as string] ?? '')
                : '';
              const direction = directionValue
                ? /in|credit/i.test(directionValue)
                  ? 'in'
                  : 'out'
                : amount < 0
                  ? 'out'
                  : 'in';
              const balance = inferred.balance
                ? parseAmount(row[inferred.balance as string])
                : null;
              return {
                date,
                description,
                amount: Math.abs(amount),
                currency: (inferred.currency && row[inferred.currency as string]) || 'USD',
                direction,
                balance,
                category: (inferred.category && row[inferred.category as string]) || null,
                account:
                  (inferred.account && row[inferred.account as string]) || input.account || null,
                merchant: description,
              } satisfies TransactionFields;
            })
            .filter((row): row is TransactionFields => row !== null);
        } else {
          const parsed = parseStatementText(text);
          transactions = parsed.rows.map((row) => ({
            ...row,
            account: input.account ?? row.account,
          }));
          unparsed = parsed.unparsed;
          genericRows = [];
        }
      }

      const signature = mappingSignature(headers);
      const saved = headers.length
        ? await ctx.database.query<{ mapping: Record<string, string> }>(
            `SELECT mapping FROM extraction_mappings WHERE signature = $1`,
            [signature],
          )
        : [];
      const mapping = input.mapping ?? saved[0]?.mapping ?? inferred;
      const needsConfirmation =
        headers.length > 0 && !input.mapping && !saved[0] && !input.confirmMapping;

      let reviewReason: string | null = needsConfirmation
        ? 'confirm the column mapping before this dataset appears in charts'
        : null;
      if (profile === 'transactions' && transactions.length === 0) {
        reviewReason = 'no transaction rows could be parsed from this file';
      }
      if (unparsed.length > 0 && transactions.length === 0) {
        reviewReason = `could not parse ${unparsed.length} statement line(s)`;
      }

      // Reconciliation gate: never silently feed a dashboard a bad statement.
      if (profile === 'transactions' && transactions.length > 0 && !reviewReason) {
        let opening = input.openingBalance;
        let closing = input.closingBalance;
        if (opening === undefined || closing === undefined) {
          const withBalance = transactions.filter((row) => row.balance !== null);
          if (withBalance.length >= 2) {
            const first = withBalance[0] as TransactionFields;
            const last = withBalance[withBalance.length - 1] as TransactionFields;
            opening = Number(first.balance) - signedAmount(first);
            closing = Number(last.balance);
          }
        }
        if (opening !== undefined && closing !== undefined) {
          const computed = opening + transactions.reduce((sum, row) => sum + signedAmount(row), 0);
          if (Math.abs(computed - closing) > 0.01) {
            reviewReason = `statement does not reconcile (${computed.toFixed(2)} vs ${closing.toFixed(2)})`;
          }
        }
      }

      const datasetId = ulid();
      const status = reviewReason ? 'needs_review' : 'ready';
      await ctx.database.query(
        `INSERT INTO extracted_datasets
           (id, title, profile, status, source_id, source_label, pinned, sensitivity, mapping,
            review_reason, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          datasetId,
          input.title,
          profile,
          status,
          input.sourceId ?? null,
          input.sourceLabel,
          input.pinned,
          options.defaultSensitivity,
          mapping,
          reviewReason,
          ownerId,
        ],
      );

      const result =
        profile === 'transactions'
          ? await insertTransactionRows(datasetId, transactions, ownerId)
          : await insertGenericRows(datasetId, genericRows);
      await ctx.database.query(
        `UPDATE extracted_datasets SET row_count = $2, updated_at = now() WHERE id = $1`,
        [datasetId, result.inserted],
      );
      if (headers.length > 0 && input.confirmMapping && signature) {
        await ctx.database.query(
          `INSERT INTO extraction_mappings (signature, profile, mapping) VALUES ($1,$2,$3)
           ON CONFLICT (signature) DO UPDATE SET profile = EXCLUDED.profile,
             mapping = EXCLUDED.mapping, updated_at = now()`,
          [signature, profile, mapping],
        );
      }
      const dataset = (await loadDataset(datasetId)) as DatasetRow;
      if (dataset.status === 'ready') await embedSummary(dataset);
      return {
        dataset,
        mapping,
        needsMappingConfirmation: needsConfirmation,
        inserted: result.inserted,
        duplicates: result.duplicates,
      };
    };

    const readSummary = async (dataset: DatasetRow) => {
      const rows = await ctx.database.query<RowRow>(
        `SELECT * FROM extracted_rows WHERE dataset_id = $1 ORDER BY created_at`,
        [dataset.id],
      );
      if (dataset.profile !== 'transactions') {
        return DatasetSummarySchema.parse({
          dataset: datasetDto(dataset),
          totals: { in: 0, out: 0, net: 0, rows: rows.length },
          byCategory: [],
          byMonth: [],
          topMerchants: [],
          recurring: [],
        });
      }
      const transactions = rows.map((row) => row.fields as unknown as TransactionFields);
      let inTotal = 0;
      let outTotal = 0;
      const byCategory = new Map<string, { total: number; count: number }>();
      const byMonth = new Map<string, { total: number; count: number }>();
      const merchants = new Map<string, { total: number; count: number }>();
      const recurring = new Map<string, { amount: number; occurrences: number }>();
      for (const transaction of transactions) {
        if (transaction.direction === 'in') inTotal += transaction.amount;
        else outTotal += transaction.amount;
        const category = transaction.category ?? 'Uncategorised';
        byCategory.set(category, {
          total: (byCategory.get(category)?.total ?? 0) + transaction.amount,
          count: (byCategory.get(category)?.count ?? 0) + 1,
        });
        const month = transaction.date.slice(0, 7);
        byMonth.set(month, {
          total: (byMonth.get(month)?.total ?? 0) + transaction.amount,
          count: (byMonth.get(month)?.count ?? 0) + 1,
        });
        const merchant = transaction.merchant || transaction.description;
        merchants.set(merchant, {
          total: (merchants.get(merchant)?.total ?? 0) + transaction.amount,
          count: (merchants.get(merchant)?.count ?? 0) + 1,
        });
        const previous = recurring.get(merchant);
        if (previous) previous.occurrences += 1;
        else recurring.set(merchant, { amount: Math.abs(transaction.amount), occurrences: 1 });
      }
      return DatasetSummarySchema.parse({
        dataset: datasetDto(dataset),
        totals: {
          in: Number(inTotal.toFixed(2)),
          out: Number(outTotal.toFixed(2)),
          net: Number((inTotal - outTotal).toFixed(2)),
          rows: rows.length,
        },
        byCategory: [...byCategory].map(([category, value]) => ({
          category,
          total: Number(value.total.toFixed(2)),
          count: value.count,
        })),
        byMonth: [...byMonth]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, value]) => ({
            month,
            total: Number(value.total.toFixed(2)),
            count: value.count,
          })),
        topMerchants: [...merchants]
          .sort(([, a], [, b]) => b.total - a.total)
          .slice(0, 10)
          .map(([merchant, value]) => ({
            merchant,
            total: Number(value.total.toFixed(2)),
            count: value.count,
          })),
        recurring: [...recurring]
          .filter(([, value]) => value.occurrences >= 2)
          .sort(([, a], [, b]) => b.occurrences - a.occurrences)
          .slice(0, 10)
          .map(([description, value]) => ({
            description,
            amount: Number(value.amount.toFixed(2)),
            occurrences: value.occurrences,
          })),
      });
    };

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/data-extract/datasets',
      handler: async (request) => {
        const result = await importDataset(
          request.body as z.input<typeof ImportDatasetRequestSchema>,
          request.ownerScope ?? request.actorId ?? null,
        );
        return ImportDatasetResponseSchema.parse({
          dataset: datasetDto(result.dataset),
          mapping: result.mapping,
          needsMappingConfirmation: result.needsMappingConfirmation,
          inserted: result.inserted,
          duplicates: result.duplicates,
        });
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/data-extract/datasets',
      handler: async (request) => {
        const owner = request.ownerScope ?? request.actorId ?? null;
        const visible = request.role === 'admin' || !owner ? '' : 'WHERE owner_id = $1';
        const rows = await ctx.database.query<DatasetRow>(
          `SELECT * FROM extracted_datasets ${visible}
            ORDER BY updated_at DESC LIMIT 200`,
          visible ? [owner] : [],
        );
        return rows.map(datasetDto);
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/data-extract/datasets/:id',
      handler: async (request) => {
        const dataset = await loadDataset(request.params.id);
        if (!dataset) throw new AppError('NOT_FOUND', 'dataset not found');
        if (
          request.role !== 'admin' &&
          dataset.owner_id &&
          dataset.owner_id !== (request.ownerScope ?? request.actorId)
        ) {
          throw new AppError('NOT_FOUND', 'dataset not found');
        }
        return datasetDto(dataset);
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/data-extract/datasets/:id/rows',
      handler: async (request) => {
        const dataset = await loadDataset(request.params.id);
        if (!dataset) throw new AppError('NOT_FOUND', 'dataset not found');
        assertRowsReadable(dataset, request.ownerScope ?? request.actorId ?? null);
        const rows = await ctx.database.query<RowRow>(
          `SELECT * FROM extracted_rows WHERE dataset_id = $1 ORDER BY created_at LIMIT 500`,
          [dataset.id],
        );
        return { dataset: datasetDto(dataset), rows: rows.map(rowDto) };
      },
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/data-extract/datasets/:id/summary',
      handler: async (request) => {
        const dataset = await loadDataset(request.params.id);
        if (!dataset) throw new AppError('NOT_FOUND', 'dataset not found');
        assertRowsReadable(dataset, request.ownerScope ?? request.actorId ?? null);
        return readSummary(dataset);
      },
    });

    ctx.registerRoute({
      method: 'PATCH',
      url: '/api/v1/data-extract/datasets/:id',
      handler: async (request) => {
        const dataset = await loadDataset(request.params.id);
        if (!dataset) throw new AppError('NOT_FOUND', 'dataset not found');
        const body = z
          .object({ pinned: z.boolean() })
          .strict()
          .parse(request.body ?? {});
        await ctx.database.query(
          `UPDATE extracted_datasets SET pinned = $2, updated_at = now() WHERE id = $1`,
          [dataset.id, body.pinned],
        );
        return datasetDto((await loadDataset(dataset.id)) as DatasetRow);
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/data-extract/datasets/:id/confirm',
      handler: async (request) => {
        const dataset = await loadDataset(request.params.id);
        if (!dataset) throw new AppError('NOT_FOUND', 'dataset not found');
        const body = z
          .object({ mapping: z.record(z.string(), z.string()).optional() })
          .strict()
          .parse(request.body ?? {});
        // Reconciliation is re-checked by the caller via a fresh import; here a
        // human confirms that the inferred mapping is acceptable.
        await ctx.database.query(
          `UPDATE extracted_datasets
              SET status = 'ready', review_reason = NULL, mapping = $2, updated_at = now()
            WHERE id = $1`,
          [dataset.id, body.mapping ?? dataset.mapping],
        );
        const ready = (await loadDataset(dataset.id)) as DatasetRow;
        await embedSummary(ready);
        return datasetDto(ready);
      },
    });

    ctx.registerRoute({
      method: 'DELETE',
      url: '/api/v1/data-extract/datasets/:id',
      handler: async (request) => {
        const dataset = await loadDataset(request.params.id);
        if (!dataset) throw new AppError('NOT_FOUND', 'dataset not found');
        if (
          request.role !== 'admin' &&
          dataset.owner_id &&
          dataset.owner_id !== (request.ownerScope ?? request.actorId)
        ) {
          throw new AppError('NOT_FOUND', 'dataset not found');
        }
        await ctx.capabilities.vectorStore?.deleteByDocument(collection, dataset.id);
        await ctx.database.query(`DELETE FROM extracted_datasets WHERE id = $1`, [dataset.id]);
        return { deleted: true, datasetId: dataset.id };
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/data-extract/rules',
      handler: async (request) => {
        const rule = DatasetRuleSchema.parse(request.body ?? {});
        await ctx.database.query(
          `INSERT INTO extraction_rules (id, keyword, category, owner_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (keyword, category) DO NOTHING`,
          [ulid(), rule.keyword, rule.category, request.ownerScope ?? request.actorId ?? null],
        );
        return { saved: true, ...rule };
      },
    });

    ctx.registerTool({
      name: 'data_extract.query_dataset',
      version: '0.1.0',
      owner: 'data-extract',
      description:
        'Query a structured dataset with a fixed filter and aggregate schema. Returns rows plus the SQL used; never accepts raw SQL.',
      examples: [{ datasetId: 'ds_1', aggregate: 'sum' as const }],
      input: DatasetQuerySchema,
      output: DatasetQueryResultSchema,
      access: 'read',
      risk: 'low',
      scopes: ['data_extract:read'],
      egressClass: 'restricted',
      idempotent: true,
      timeoutMs: 5_000,
      undo: 'free',
      retry: { maxAttempts: 1, backoff: 'none', retryOn: [] },
      handler: async (input, toolCtx) =>
        queryDataset(
          ctx,
          input as DatasetQuery,
          toolCtx.ownerScope ?? toolCtx.actorId ?? null,
          toolCtx.hosted ?? true,
        ),
    });

    ctx.registerDashboardProvider({
      id: 'data-extract',
      async read({ database }) {
        const datasets = await database.query<{
          id: string;
          title: string;
          profile: string;
          row_count: number;
          created_at: Date | string;
          pinned: boolean;
        }>(
          `SELECT id, title, profile, row_count, created_at, pinned
             FROM extracted_datasets WHERE status = 'ready' ORDER BY updated_at DESC LIMIT 200`,
        );
        const points = datasets
          .filter(
            (dataset) => new Date(dataset.created_at) > new Date(Date.now() - 14 * 86_400_000),
          )
          .map((dataset) => ({
            bucket: new Date(dataset.created_at).toISOString().slice(0, 10),
            datasets: 1,
          }));
        return {
          datasetPoints: points,
          pinnedDatasets: datasets
            .filter((dataset) => dataset.pinned)
            .slice(0, 6)
            .map((dataset) => ({
              id: dataset.id,
              title: dataset.title,
              profile: dataset.profile,
              rowCount: Number(dataset.row_count ?? 0),
              total: null,
            })),
        };
      },
    });

    // A KB source that produced tabular text can auto-import as a dataset.
    ctx.events.subscribe('kb.source.ingested', async (payload) => {
      const event = z
        .object({
          sourceId: z.string(),
          title: z.string(),
          text: z.string().max(500_000),
          mediaType: z.string().optional(),
          ownerId: z.string().nullable().optional(),
        })
        .safeParse(payload);
      if (!event.success) return;
      const existing = await ctx.database.query<{ id: string }>(
        `SELECT id FROM extracted_datasets WHERE source_id = $1`,
        [event.data.sourceId],
      );
      if (existing.length > 0) return;
      if (!/[,\t;]/.test(event.data.text.split('\n')[0] ?? '')) return;
      try {
        await importDataset(
          {
            title: event.data.title,
            content: event.data.text,
            mediaType:
              event.data.mediaType === 'text/tab-separated-values'
                ? 'text/tab-separated-values'
                : 'text/csv',
            sourceId: event.data.sourceId,
            sourceLabel: 'knowledge source',
            confirmMapping: false,
          },
          event.data.ownerId ?? null,
        );
      } catch {
        // A source that is not tabular must not fail KB ingestion.
      }
    });
  },
};

function assertRowsReadable(dataset: DatasetRow, owner: string | null): void {
  if (dataset.sensitivity === 'restricted' && dataset.owner_id && dataset.owner_id !== owner) {
    throw new AppError(
      'data_extract.FORBIDDEN',
      'restricted dataset rows are visible to the owner only',
      undefined,
      403,
    );
  }
}

async function queryDataset(
  ctx: KernelContext,
  input: DatasetQuery,
  ownerScope: string | null,
  hosted: boolean,
) {
  const rows = input.datasetId
    ? await ctx.database.query<DatasetRow>(`SELECT * FROM extracted_datasets WHERE id = $1`, [
        input.datasetId,
      ])
    : [];
  const dataset = rows[0];
  if (!dataset || dataset.status !== 'ready') {
    throw new AppError(
      'data_extract.NOT_READY',
      'dataset is missing or needs review',
      undefined,
      409,
    );
  }
  if (dataset.sensitivity === 'restricted' && dataset.owner_id && dataset.owner_id !== ownerScope) {
    throw new AppError('NOT_FOUND', 'dataset not found');
  }
  const gate = classifySend({
    sensitivity: dataset.sensitivity,
    hosted,
    modelUse: dataset.sensitivity === 'restricted' ? 'local_only' : 'allowed',
  });
  if (gate.decision === 'withheld') {
    throw new AppError(
      'data_extract.WITHHELD',
      'this dataset may not be sent to a remote model',
      undefined,
      403,
    );
  }

  const clauses = ['dataset_id = $1'];
  const params: unknown[] = [dataset.id];
  if (input.from) {
    params.push(input.from);
    clauses.push(`fields->>'date' >= $${params.length}`);
  }
  if (input.to) {
    params.push(input.to);
    clauses.push(`fields->>'date' <= $${params.length}`);
  }
  if (input.category) {
    params.push(input.category);
    clauses.push(`fields->>'category' = $${params.length}`);
  }
  if (input.merchantContains) {
    params.push(`%${input.merchantContains.replace(/[\\%_]/g, '\\$&')}%`);
    clauses.push(`fields->>'merchant' ILIKE $${params.length} ESCAPE '\\'`);
  }
  if (input.direction) {
    params.push(input.direction);
    clauses.push(`fields->>'direction' = $${params.length}`);
  }
  const where = clauses.join(' AND ');
  const queryText = `SELECT ${input.aggregate === 'rows' ? '*' : input.aggregate === 'count' ? 'COUNT(*) AS count' : "SUM((fields->>'amount')::numeric) AS total"} FROM extracted_rows WHERE ${where}`;
  if (input.aggregate === 'sum') {
    const total = await ctx.database.query<{ total: string | null }>(queryText, params);
    return DatasetQueryResultSchema.parse({
      datasetId: dataset.id,
      aggregate: 'sum',
      total: total[0]?.total === null ? 0 : Number(total[0]?.total ?? 0),
      rows: [],
      query: queryText,
    });
  }
  if (input.aggregate === 'count') {
    const count = await ctx.database.query<{ count: number }>(queryText, params);
    return DatasetQueryResultSchema.parse({
      datasetId: dataset.id,
      aggregate: 'count',
      total: Number(count[0]?.count ?? 0),
      rows: [],
      query: queryText,
    });
  }
  const result = await ctx.database.query<RowRow>(
    `SELECT * FROM extracted_rows WHERE ${where} ORDER BY created_at LIMIT $${params.length + 1}`,
    [...params, input.limit],
  );
  return DatasetQueryResultSchema.parse({
    datasetId: dataset.id,
    aggregate: 'rows',
    total: result.length,
    rows: result.map(rowDto),
    query: queryText,
  });
}
