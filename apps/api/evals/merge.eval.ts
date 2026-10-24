/**
 * Merge classifier, retrieval, and generation eval artifacts into the single
 * report format consumed by the model registry (Phase 6, contract-testing §5).
 *
 *   pnpm --filter @triageai/api exec tsx evals/merge.eval.ts
 *
 * Inputs are produced by:
 *   apps/ai-service/eval/run_eval.py        → apps/ai-service/eval/reports/latest.json
 *   apps/api/evals/retrieval.eval.ts        → apps/api/evals/reports/retrieval-latest.json
 *   apps/api/evals/generation.eval.ts       → apps/api/evals/reports/generation-latest.json
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evalReportMarkdown, mergeEvalSuites } from '../src/platform/evalReports.js';
import type { SuiteInput } from '../src/platform/evalReports.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function main(): Promise<number> {
  const classification = await readJson<{
    generatedAt: string;
    macroF1: number;
    p95LatencyMs: number;
    falseAutoRoutingCount: number;
    gates: { macro_f1: number; p95_ms: number; false_auto_routing: number };
  }>(path.join(REPO_ROOT, 'apps/ai-service/eval/reports/latest.json'));
  const retrieval = await readJson<{
    generatedAt: string;
    recallAt3: number;
    mrr: number;
    gates: { recallAt3: number };
  }>(path.join(HERE, 'reports/retrieval-latest.json'));
  const generation = await readJson<{
    status: 'passed' | 'failed';
    metrics: Record<string, number>;
    gates: Record<string, number>;
  }>(path.join(HERE, 'reports/generation-latest.json'));

  const classificationPassed =
    classification.macroF1 >= classification.gates.macro_f1 &&
    classification.p95LatencyMs <= classification.gates.p95_ms &&
    classification.falseAutoRoutingCount <= classification.gates.false_auto_routing;
  const suites: SuiteInput[] = [
    {
      suite: 'classification',
      status: classificationPassed ? 'passed' : 'failed',
      metrics: {
        macroF1: classification.macroF1,
        p95LatencyMs: classification.p95LatencyMs,
        falseAutoRoutingCount: classification.falseAutoRoutingCount,
      },
      gates: {
        macroF1: classification.gates.macro_f1,
        p95LatencyMs: classification.gates.p95_ms,
        falseAutoRoutingCount: classification.gates.false_auto_routing,
      },
    },
    {
      suite: 'retrieval',
      status: retrieval.recallAt3 >= retrieval.gates.recallAt3 ? 'passed' : 'failed',
      metrics: { recallAt3: retrieval.recallAt3, mrr: retrieval.mrr },
      gates: { recallAt3: retrieval.gates.recallAt3 },
    },
    {
      suite: 'generation',
      status: generation.status,
      metrics: generation.metrics,
      gates: generation.gates,
    },
  ];

  const merged = mergeEvalSuites(suites, {
    generatedAt: new Date().toISOString(),
    artifact: 'apps/api/evals/reports/merged-latest.json',
    notes: `Sources: classification ${classification.generatedAt}, retrieval ${retrieval.generatedAt}`,
  });
  const reportsDir = path.join(HERE, 'reports');
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, 'merged-latest.json'), JSON.stringify(merged, null, 2));
  await writeFile(path.join(reportsDir, 'merged-latest.md'), evalReportMarkdown(merged));

  console.log(
    JSON.stringify(
      {
        passes: merged.passes,
        suites: merged.suites.map((suite) => `${suite.suite}:${suite.status}`),
        metrics: merged.metrics,
      },
      null,
      2,
    ),
  );
  if (!merged.passes) {
    console.error('GATE FAILURE: merged eval report is failing');
    return 1;
  }
  return 0;
}

void main().then((code) => process.exit(code));
