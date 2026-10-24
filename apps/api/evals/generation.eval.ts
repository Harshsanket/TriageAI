/**
 * Generation/validation eval suite (Phase 6, CI gate).
 *
 * Runs the deterministic post-generation pipeline (grounding decision, citation
 * attachment, refusal, validation stack) over labeled fixtures. Model-authored
 * answers are the fixture payload, so CI does not need a running LLM; live
 * model runs are documented separately (docs/learnings/0005-rag-and-chunking.md).
 *
 *   pnpm --filter @triageai/api exec tsx evals/generation.eval.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeAnswer, runValidation } from '@triageai/rag';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATES = {
  groundedness: 0.8,
  refusalCorrectness: 0.8,
  citationCoverage: 0.8,
  validationPassRate: 1,
};

interface GenerationCase {
  id: string;
  question: string;
  sources: Array<{ ref: string; text: string }>;
  answer: string;
  expected: {
    grounded: boolean;
    refused: boolean;
    validationPassed?: boolean;
  };
}

async function main(): Promise<number> {
  const fixtures = JSON.parse(
    await readFile(path.join(HERE, 'fixtures/generation.json'), 'utf8'),
  ) as { cases: GenerationCase[] };

  let groundedCorrect = 0;
  let groundedExpected = 0;
  let refusalCorrect = 0;
  let cited = 0;
  let validationCorrect = 0;
  let validationExpected = 0;
  const rows: Array<Record<string, unknown>> = [];

  for (const item of fixtures.cases) {
    const finalized = finalizeAnswer({
      answer: item.answer,
      sources: item.sources,
      threshold: 0.6,
    });
    const validation = runValidation({
      text: finalized.answer,
      sources: item.sources,
      question: item.question,
      citations: finalized.citations,
    });
    if (item.expected.grounded) {
      groundedExpected += 1;
      if (finalized.grounding.grounded) groundedCorrect += 1;
      if (finalized.citations.length > 0) cited += 1;
    }
    if (finalized.refused === item.expected.refused) refusalCorrect += 1;
    if (item.expected.validationPassed !== undefined) {
      validationExpected += 1;
      if (validation.passed === item.expected.validationPassed) validationCorrect += 1;
    }
    rows.push({
      id: item.id,
      grounded: finalized.grounding.grounded,
      coverage: Number(finalized.grounding.coverage.toFixed(4)),
      refused: finalized.refused,
      citations: finalized.citations,
      validationPassed: validation.passed,
      failedChecks: validation.checks
        .filter((check) => !check.passed)
        .map((check) => check.checkId),
    });
  }

  const total = fixtures.cases.length;
  const metrics = {
    groundedness:
      groundedExpected === 0 ? 1 : Number((groundedCorrect / groundedExpected).toFixed(4)),
    refusalCorrectness: Number((refusalCorrect / total).toFixed(4)),
    citationCoverage: groundedExpected === 0 ? 1 : Number((cited / groundedExpected).toFixed(4)),
    validationPassRate:
      validationExpected === 0 ? 1 : Number((validationCorrect / validationExpected).toFixed(4)),
  };
  const passed =
    metrics.groundedness >= GATES.groundedness &&
    metrics.refusalCorrectness >= GATES.refusalCorrectness &&
    metrics.citationCoverage >= GATES.citationCoverage &&
    metrics.validationPassRate >= GATES.validationPassRate;

  const report = {
    generatedAt: new Date().toISOString(),
    suite: 'generation',
    status: passed ? 'passed' : 'failed',
    cases: total,
    metrics,
    gates: GATES,
    results: rows,
  };
  const reportsDir = path.join(HERE, 'reports');
  await mkdir(reportsDir, { recursive: true });
  await writeFile(path.join(reportsDir, 'generation-latest.json'), JSON.stringify(report, null, 2));

  console.log(JSON.stringify({ suite: 'generation', metrics, status: report.status }, null, 2));
  if (!passed) {
    console.error('GATE FAILURE: generation suite did not meet all gates');
    return 1;
  }
  return 0;
}

void main().then((code) => process.exit(code));
