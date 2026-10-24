/**
 * One eval-report format for every suite (Phase 6, contract-testing §5).
 * Classifier, retrieval, and generation suites each produce a suite block; the
 * merged report is what the registry consumes and what CI uploads as an
 * artifact (`eval_reports` row + Markdown attachment).
 */
import type { EvalMetrics, EvalReportInput, EvalSuiteResult } from '@triageai/contracts';

export interface SuiteInput {
  suite: string;
  status: 'passed' | 'failed';
  metrics: Record<string, number>;
  gates?: Record<string, number>;
  details?: Record<string, unknown>;
}

const CANONICAL_METRICS = [
  'macroF1',
  'falseAutoRoutingCount',
  'p95LatencyMs',
  'recallAt3',
  'mrr',
  'groundedness',
  'citationCoverage',
] as const;

export function mergeEvalSuites(
  suites: SuiteInput[],
  opts: {
    generatedAt?: string;
    subjectModelId?: string | null;
    baselineModelId?: string | null;
    artifact?: string | null;
    notes?: string | null;
  } = {},
): EvalReportInput {
  const metrics: EvalMetrics = {};
  for (const suite of suites) {
    for (const key of CANONICAL_METRICS) {
      if (metricValue(suite.metrics, key) !== undefined && metrics[key] === undefined) {
        (metrics as Record<string, number | null>)[key] = metricValue(suite.metrics, key) ?? null;
      }
    }
    for (const [key, value] of Object.entries(suite.metrics)) {
      if ((CANONICAL_METRICS as readonly string[]).includes(key)) continue;
      if (typeof value === 'number' && metrics[key] === undefined) {
        (metrics as Record<string, number>)[key] = value;
      }
    }
  }
  const normalizedSuites: EvalSuiteResult[] = suites.map((suite) => ({
    suite: suite.suite,
    status: suite.status,
    metrics: suite.metrics,
    gates: suite.gates ?? {},
    ...(suite.details ? { details: suite.details } : {}),
  }));
  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    subjectModelId: opts.subjectModelId ?? null,
    baselineModelId: opts.baselineModelId ?? null,
    suites: normalizedSuites,
    metrics,
    passes: suites.every((suite) => suite.status === 'passed'),
    artifact: opts.artifact ?? null,
    notes: opts.notes ?? null,
  };
}

function metricValue(metrics: Record<string, number>, key: string): number | undefined {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function evalReportMarkdown(report: EvalReportInput): string {
  const lines = [
    '# TriageAI eval report',
    '',
    `- Generated: ${report.generatedAt}`,
    `- Result: **${report.passes ? 'PASS' : 'FAIL'}**`,
    `- Subject model: ${report.subjectModelId ?? '—'}`,
    `- Baseline model: ${report.baselineModelId ?? '—'}`,
    '',
    '| Suite | Status | Gates | Metrics |',
    '| --- | --- | --- | --- |',
  ];
  for (const suite of report.suites) {
    lines.push(
      `| ${suite.suite} | ${suite.status} | ${formatObject(suite.gates)} | ${formatObject(suite.metrics)} |`,
    );
  }
  lines.push(
    '',
    '## Merged metrics',
    '',
    '```json',
    JSON.stringify(report.metrics, null, 2),
    '```',
  );
  if (report.notes) lines.push('', report.notes);
  return `${lines.join('\n')}\n`;
}

function formatObject(value: Record<string, number>): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}=${entry}`)
    .join(', ');
}
