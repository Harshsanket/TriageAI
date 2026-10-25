/**
 * Correction export → blessed fixture sets (Phase 7).
 *
 * Reads approved candidate examples, groups them by category, and writes one
 * JSON fixture per category under apps/ai-service/eval/blessed/. The
 * classification eval merges these with its curated fixtures, so human
 * corrections become regression tests without hand-editing fixture files.
 *
 *   DATABASE_URL=... pnpm --filter @triageai/api exec tsx evals/exportFixtures.eval.ts
 *
 * Commit the generated files when the corrections are intentionally blessed.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORE_MIGRATIONS,
  MIGRATIONS_TABLE_SQL,
  MigrationRunner,
  PostgresDatabase,
} from '@triageai/kernel';

import { candidateText } from '../src/platform/candidates.js';
import { labelOf, stableStringify } from '../src/platform/datasets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT = path.resolve(HERE, '../../ai-service/eval/blessed');
const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface CandidateRow {
  [key: string]: unknown;
  id: string;
  input: unknown;
  gold: unknown;
  provenance: Record<string, unknown>;
  created_at: Date | string;
}

function safeName(category: string): string {
  return category.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase() || 'unknown';
}

async function main(): Promise<number> {
  const databaseUrl =
    process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
  const database = new PostgresDatabase(databaseUrl);
  try {
    await database.query(MIGRATIONS_TABLE_SQL);
    await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
    const rows = (await database.query<CandidateRow>(
      `SELECT id, input, gold, provenance, created_at
       FROM candidate_examples
       WHERE status = 'approved'
       ORDER BY created_at ASC, id ASC`,
    )) as unknown as CandidateRow[];

    const groups = new Map<string, CandidateRow[]>();
    for (const row of rows) {
      const category = labelOf(row.gold);
      groups.set(category, [...(groups.get(category) ?? []), row]);
    }

    await mkdir(OUTPUT, { recursive: true });
    const written: Array<{ category: string; file: string; count: number }> = [];
    for (const category of [...groups.keys()].sort()) {
      const examples = (groups.get(category) ?? []).map((row) => ({
        text: candidateText(row.input),
        expected: category,
        sourceCandidateId: row.id,
        provenance: row.provenance ?? {},
      }));
      const file = path.join(OUTPUT, `${safeName(category)}.json`);
      await writeFile(
        file,
        `${JSON.stringify(
          {
            category,
            generatedAt: new Date().toISOString(),
            source: 'approved-candidate-examples',
            examples,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      written.push({ category, file, count: examples.length });
    }
    const manifest = {
      generatedAt: new Date().toISOString(),
      status: 'approved',
      total: rows.length,
      categories: written,
      hash: createHash('sha256')
        .update(
          stableStringify(
            [...groups.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([category, items]) => [category, items.map((item) => item.id)]),
          ),
        )
        .digest('hex'),
    };
    await writeFile(
      path.join(OUTPUT, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  } finally {
    await database.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
