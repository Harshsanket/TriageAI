/**
 * Deterministic dataset builder (Phase 6).
 *
 * Splits are stratified by label and ordered by time, while every example that
 * shares a source run (or an identical input) stays in one split — the leakage
 * guard. The dataset hash is a pure function of the approved examples, so a
 * rebuild with unchanged inputs returns the same version (idempotent).
 */
import { createHash } from 'node:crypto';

import { ulid } from 'ulid';

import type { DatasetDto, DatasetSplitCounts, DatasetSplitName } from '@triageai/contracts';
import type { Database } from '@triageai/kernel';

import { AppError } from './errors.js';
import { writeAudit } from './audit.js';

export interface BuildableExample {
  id: string;
  source: string;
  sourceGroup: string;
  label: string;
  createdAt: string;
  input: unknown;
  gold: unknown;
  provenance: Record<string, unknown>;
}

export interface DatasetRatios {
  train: number;
  val: number;
  test: number;
}

export interface DatasetPlan {
  splits: Record<DatasetSplitName, string[]>;
  counts: DatasetSplitCounts;
  classBalance: Record<string, DatasetSplitCounts>;
  exampleHashes: Record<string, string>;
  sha256: string;
  strategy: string;
}

const DEFAULT_RATIOS: DatasetRatios = { train: 0.7, val: 0.15, test: 0.15 };
const DEFAULT_PURPOSE = 'classifier';
const STRATEGY = 'stratified_by_label_time_ordered_source_grouped';

/** Stable JSON: recursively sort object keys so hashes do not depend on key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

export function hashExample(
  example: Pick<BuildableExample, 'id' | 'input' | 'gold' | 'provenance'>,
): string {
  return createHash('sha256')
    .update(
      stableStringify({
        id: example.id,
        input: example.input,
        gold: example.gold,
        provenance: example.provenance,
      }),
    )
    .digest('hex');
}

/** Label priority: explicit category/label on the gold value, else `unknown`. */
export function labelOf(gold: unknown): string {
  if (gold && typeof gold === 'object') {
    const record = gold as Record<string, unknown>;
    if (typeof record.category === 'string' && record.category.length > 0) return record.category;
    if (typeof record.label === 'string' && record.label.length > 0) return record.label;
  }
  return 'unknown';
}

/**
 * Per-label split targets. Small classes still get one example in val/test when
 * there are at least three, so a dataset never pretends to be evaluable when
 * one split is empty by rounding.
 */
function splitTargets(
  total: number,
  ratios: DatasetRatios,
): { train: number; val: number; test: number } {
  if (total <= 0) return { train: 0, val: 0, test: 0 };
  if (total === 1) return { train: 1, val: 0, test: 0 };
  if (total === 2) return { train: 1, val: 0, test: 1 };
  let val = Math.max(1, Math.round(total * ratios.val));
  let test = Math.max(1, Math.round(total * ratios.test));
  let train = Math.max(1, total - val - test);
  while (train + val + test > total) {
    if (test > 1) test -= 1;
    else if (val > 1) val -= 1;
    else train -= 1;
  }
  return { train, val, test };
}

interface Group {
  key: string;
  examples: BuildableExample[];
  earliest: string;
}

function groupOf(examples: BuildableExample[]): Group[] {
  const groups = new Map<string, Group>();
  for (const example of examples) {
    const key = example.sourceGroup;
    const existing = groups.get(key);
    if (existing) {
      existing.examples.push(example);
      if (example.createdAt < existing.earliest) existing.earliest = example.createdAt;
    } else {
      groups.set(key, { key, examples: [example], earliest: example.createdAt });
    }
  }
  return [...groups.values()];
}

/**
 * Build a split plan. Pure: same inputs (in any order) produce the same hash and
 * assignments; no example or source run appears in two splits.
 */
export function planDataset(
  examples: BuildableExample[],
  ratios: DatasetRatios = DEFAULT_RATIOS,
  purpose = DEFAULT_PURPOSE,
): DatasetPlan {
  if (examples.length === 0) {
    throw new AppError('CONFLICT', 'no approved candidate examples are available for a dataset');
  }
  const sorted = [...examples].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const hashes = new Map<string, string>();
  for (const example of sorted) hashes.set(example.id, hashExample(example));

  const splitOf = new Map<string, DatasetSplitName>();
  // Source runs are the leakage unit: all their examples (even across labels)
  // move together. The group's label is its earliest example's label.
  const groups = groupOf(sorted).map((group) => {
    const first = [...group.examples].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )[0] as BuildableExample;
    return { ...group, label: first.label };
  });
  const labelTotals = new Map<string, number>();
  for (const group of groups) {
    labelTotals.set(group.label, (labelTotals.get(group.label) ?? 0) + group.examples.length);
  }
  const targetsByLabel = new Map(
    [...labelTotals.entries()].map(([label, total]) => [label, splitTargets(total, ratios)]),
  );
  const seenByLabel = new Map<string, number>();
  for (const group of groups.sort(
    (a, b) => a.earliest.localeCompare(b.earliest) || a.key.localeCompare(b.key),
  )) {
    const targets = targetsByLabel.get(group.label) ?? { train: 0, val: 0, test: 0 };
    const seen = seenByLabel.get(group.label) ?? 0;
    const split: DatasetSplitName =
      seen < targets.train ? 'train' : seen < targets.train + targets.val ? 'val' : 'test';
    for (const example of group.examples) splitOf.set(example.id, split);
    seenByLabel.set(group.label, seen + group.examples.length);
  }

  // Duplicate-input leakage guard: identical inputs always share one split.
  const splitByHash = new Map<string, DatasetSplitName>();
  for (const group of groupOf(sorted).sort((a, b) => a.earliest.localeCompare(b.earliest))) {
    const hashesInGroup = group.examples.map((example) => hashes.get(example.id) as string);
    const forced = hashesInGroup
      .map((hash) => splitByHash.get(hash))
      .find((split) => split !== undefined);
    const target = forced ?? splitOf.get(group.examples[0]?.id ?? '');
    if (!target) continue;
    for (const example of group.examples) {
      splitOf.set(example.id, target);
      splitByHash.set(hashes.get(example.id) as string, target);
    }
  }

  const splits: Record<DatasetSplitName, string[]> = { train: [], val: [], test: [] };
  const classBalance: Record<string, DatasetSplitCounts> = {};
  for (const example of sorted) {
    const split = splitOf.get(example.id);
    if (!split) continue;
    splits[split].push(example.id);
    const labelCounts = (classBalance[example.label] ??= { train: 0, val: 0, test: 0 });
    labelCounts[split] += 1;
  }
  for (const split of ['train', 'val', 'test'] as const) splits[split].sort();

  const counts: DatasetSplitCounts = {
    train: splits.train.length,
    val: splits.val.length,
    test: splits.test.length,
  };
  const sha256 = createHash('sha256')
    .update(
      stableStringify({
        purpose,
        ratios,
        examples: sorted.map((example) => ({
          id: example.id,
          hash: hashes.get(example.id),
          split: splitOf.get(example.id),
        })),
      }),
    )
    .digest('hex');

  return {
    splits,
    counts,
    classBalance,
    exampleHashes: Object.fromEntries(hashes),
    sha256,
    strategy: STRATEGY,
  };
}

interface CandidateRow {
  [key: string]: unknown;
  id: string;
  source: string;
  source_run_id: string | null;
  input: unknown;
  gold: unknown;
  provenance: Record<string, unknown>;
  created_at: Date | string;
}

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

export function datasetDto(row: DatasetRow): DatasetDto {
  const splits = (row.example_ids ?? { train: [], val: [], test: [] }) as Record<
    DatasetSplitName,
    string[]
  >;
  const meta = (row.splits ?? {}) as {
    counts?: DatasetSplitCounts;
    classBalance?: Record<string, DatasetSplitCounts>;
    strategy?: string;
  };
  const counts = meta.counts ?? {
    train: splits.train?.length ?? 0,
    val: splits.val?.length ?? 0,
    test: splits.test?.length ?? 0,
  };
  return {
    id: row.id,
    version: row.version,
    purpose: row.purpose,
    sha256: row.sha256,
    splits: {
      train: splits.train ?? [],
      val: splits.val ?? [],
      test: splits.test ?? [],
    },
    counts,
    classBalance: meta.classBalance ?? {},
    strategy: meta.strategy ?? STRATEGY,
    createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by,
  };
}

export async function buildDataset(
  database: Database,
  input: { purpose?: string; ratios?: DatasetRatios; createdBy?: string },
): Promise<{ dataset: DatasetDto; reused: boolean }> {
  const purpose = input.purpose ?? DEFAULT_PURPOSE;
  const ratios = input.ratios ?? DEFAULT_RATIOS;
  const rows = (await database.query<CandidateRow>(
    `SELECT id, source, source_run_id, input, gold, provenance, created_at
     FROM candidate_examples
     WHERE status = 'approved'
     ORDER BY created_at ASC, id ASC`,
  )) as unknown as CandidateRow[];
  const examples: BuildableExample[] = rows.map((row) => ({
    id: row.id,
    source: row.source,
    sourceGroup: row.source_run_id ?? `${row.source}:${row.id}`,
    label: labelOf(row.gold),
    createdAt: new Date(row.created_at).toISOString(),
    input: row.input,
    gold: row.gold,
    provenance: row.provenance ?? {},
  }));
  const plan = planDataset(examples, ratios, purpose);

  const existing = (await database.query<DatasetRow>(
    `SELECT * FROM datasets WHERE purpose = $1 AND sha256 = $2 LIMIT 1`,
    [purpose, plan.sha256],
  )) as unknown as DatasetRow[];
  if (existing[0]) return { dataset: datasetDto(existing[0]), reused: true };

  const versions = (await database.query<{ version: string }>(
    `SELECT version FROM datasets WHERE purpose = $1`,
    [purpose],
  )) as unknown as Array<{ version: string }>;
  const nextVersion =
    Math.max(0, ...versions.map((row) => Number.parseInt(row.version.replace(/^v/, ''), 10) || 0)) +
    1;
  const id = ulid();
  const createdBy = input.createdBy ?? 'admin';
  const inserted = (await database.query<DatasetRow>(
    `INSERT INTO datasets (id, version, purpose, example_ids, sha256, splits, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (purpose, sha256) DO NOTHING
     RETURNING *`,
    [
      id,
      `v${nextVersion}`,
      purpose,
      plan.splits,
      plan.sha256,
      {
        counts: plan.counts,
        classBalance: plan.classBalance,
        strategy: plan.strategy,
        exampleHashes: plan.exampleHashes,
        ratios,
      },
      createdBy,
    ],
  )) as unknown as DatasetRow[];
  if (!inserted[0]) {
    const raced = (await database.query<DatasetRow>(
      `SELECT * FROM datasets WHERE purpose = $1 AND sha256 = $2 LIMIT 1`,
      [purpose, plan.sha256],
    )) as unknown as DatasetRow[];
    return { dataset: datasetDto(raced[0] as DatasetRow), reused: true };
  }
  const dataset = datasetDto(inserted[0] as DatasetRow);
  await writeAudit(database, {
    actor: createdBy,
    action: 'dataset.built',
    subject: id,
    payload: {
      version: dataset.version,
      purpose,
      sha256: dataset.sha256,
      counts: dataset.counts,
      ratios,
    },
  });
  return { dataset, reused: false };
}
