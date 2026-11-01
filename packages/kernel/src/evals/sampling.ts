/** Online eval sampling (Phase 18.1): deterministic by run id, 100% for risky runs. */
import { createHash } from 'node:crypto';

export interface RunRisk {
  runId: string;
  hostedModel?: boolean;
  highRiskTool?: boolean;
}

export function sampleRateFor(run: RunRisk, baseRate = 0.1): number {
  if (run.hostedModel || run.highRiskTool) return 1;
  return Math.min(1, Math.max(0, baseRate));
}

/** Deterministic sampling: the same run always gets the same decision. */
export function shouldEvaluate(run: RunRisk, baseRate = 0.1): boolean {
  const rate = sampleRateFor(run, baseRate);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const bucket =
    Number.parseInt(createHash('sha256').update(run.runId).digest('hex').slice(0, 8), 16) /
    0xffffffff;
  return bucket < rate;
}

export interface EvalScore {
  runId: string;
  evaluator: string;
  method: 'deterministic' | 'judge';
  score: number;
  passed: boolean;
  floor: number;
  findings: string[];
}

export interface DeterministicOutcome {
  validatorPassed: boolean;
  citationsPresent: boolean;
  refusedCorrectly: boolean;
  piiFree: boolean;
}

export function scoreDeterministic(
  runId: string,
  outcome: DeterministicOutcome,
  floor = 0.8,
): EvalScore {
  const checks = [
    outcome.validatorPassed,
    outcome.citationsPresent || outcome.refusedCorrectly,
    outcome.piiFree,
  ];
  const score = checks.filter(Boolean).length / checks.length;
  const findings = [
    !outcome.validatorPassed ? 'validator_failed' : null,
    !outcome.citationsPresent && !outcome.refusedCorrectly ? 'missing_citation_or_refusal' : null,
    !outcome.piiFree ? 'pii_present' : null,
  ].filter((value): value is string => value !== null);
  return {
    runId,
    evaluator: 'deterministic.answer',
    method: 'deterministic',
    score,
    passed: score >= floor,
    floor,
    findings,
  };
}
