/**
 * Dataset versions (Phase 6): rebuild from the approved candidate pool with
 * immutable split/leakage rules; export for training/eval runs.
 */
import type { FastifyInstance } from 'fastify';

import {
  DatasetBuildRequestSchema,
  DatasetExampleExportSchema,
  DatasetExportDtoSchema,
} from '@triageai/contracts';
import type { DatasetSplitName } from '@triageai/contracts';
import type { Kernel } from '@triageai/kernel';

import { buildDataset, datasetDto } from '../services/datasets.js';
import { AppError } from '../platform/errors.js';

interface DatasetRow {
  [key: string]: unknown;
  id: string;
  version: string;
  purpose: string;
  example_ids: Record<DatasetSplitName, string[]>;
  sha256: string;
  splits: Record<string, unknown>;
  created_by: string | null;
  created_at: Date | string;
}

interface ExampleRow {
  [key: string]: unknown;
  id: string;
  input: unknown;
  gold: unknown;
  provenance: Record<string, unknown>;
}

async function loadDataset(kernel: Kernel, id: string): Promise<DatasetRow> {
  const rows = (await kernel.database.query<DatasetRow>(`SELECT * FROM datasets WHERE id = $1`, [
    id,
  ])) as unknown as DatasetRow[];
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', `dataset ${id} not found`);
  return row;
}

async function examplesFor(
  kernel: Kernel,
  row: DatasetRow,
): Promise<Array<{ split: DatasetSplitName; example: ExampleRow }>> {
  const splitOf = new Map<string, DatasetSplitName>();
  for (const split of ['train', 'val', 'test'] as const) {
    for (const id of row.example_ids?.[split] ?? []) splitOf.set(id, split);
  }
  const ids = [...splitOf.keys()];
  if (ids.length === 0) return [];
  const rows = (await kernel.database.query<ExampleRow>(
    `SELECT id, input, gold, provenance FROM candidate_examples WHERE id = ANY($1::text[])`,
    [ids],
  )) as unknown as ExampleRow[];
  return rows
    .map((example) => ({ example, split: splitOf.get(example.id) as DatasetSplitName }))
    .sort((a, b) => a.example.id.localeCompare(b.example.id));
}

export function registerDatasetRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/datasets', async (request) => {
    const query = request.query as { purpose?: string; limit?: string };
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
    const rows = (await kernel.database.query<DatasetRow>(
      `SELECT * FROM datasets
       WHERE ($1::text IS NULL OR purpose = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [query.purpose ?? null, limit],
    )) as unknown as DatasetRow[];
    return rows.map(datasetDto);
  });

  app.post('/api/v1/datasets', async (request, reply) => {
    const body = DatasetBuildRequestSchema.parse(request.body ?? {});
    const { dataset, reused } = await buildDataset(kernel.database, body);
    return reply.status(reused ? 200 : 201).send(dataset);
  });

  app.get('/api/v1/datasets/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = await loadDataset(kernel, id);
    const examples = await examplesFor(kernel, row);
    return {
      ...datasetDto(row),
      examples: examples.map(({ split, example }) =>
        DatasetExampleExportSchema.parse({
          id: example.id,
          split,
          input: example.input,
          gold: example.gold,
          provenance: example.provenance ?? {},
        }),
      ),
    };
  });

  app.get('/api/v1/datasets/:id/export', async (request) => {
    const { id } = request.params as { id: string };
    const row = await loadDataset(kernel, id);
    const examples = await examplesFor(kernel, row);
    return DatasetExportDtoSchema.parse({
      datasetId: row.id,
      version: row.version,
      purpose: row.purpose,
      sha256: row.sha256,
      examples: examples.map(({ split, example }) => ({
        id: example.id,
        split,
        input: example.input,
        gold: example.gold,
        provenance: example.provenance ?? {},
      })),
    });
  });
}
