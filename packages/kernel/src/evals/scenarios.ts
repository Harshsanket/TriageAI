/** Scenario grading floors (Phase 18.T27): deterministic checks first. */
import { CATEGORY_PASS_FLOOR } from '@triageai/contracts';
import type { ScenarioCase } from '@triageai/contracts';

export interface ScenarioObservation {
  edges?: string[];
  toolsCalled?: string[];
  refused?: boolean;
  clarifyingQuestion?: boolean;
  outputValid?: boolean;
}

export function gradeScenario(
  scenario: ScenarioCase,
  observed: ScenarioObservation,
): { passed: boolean; findings: string[] } {
  const findings: string[] = [];
  const expect = scenario.expect;
  if (expect.refusal !== undefined && observed.refused !== expect.refusal) {
    findings.push(`refusal_expected:${expect.refusal}`);
  }
  if (
    expect.clarifyingQuestion !== undefined &&
    observed.clarifyingQuestion !== expect.clarifyingQuestion
  ) {
    findings.push(`clarifying_expected:${expect.clarifyingQuestion}`);
  }
  if (expect.outputSchema && observed.outputValid === false) findings.push('output_schema');
  for (const tool of expect.toolsCalled ?? []) {
    if (!observed.toolsCalled?.includes(tool)) findings.push(`missing_tool:${tool}`);
  }
  for (const tool of expect.toolsNotCalled ?? []) {
    if (observed.toolsCalled?.includes(tool)) findings.push(`forbidden_tool:${tool}`);
  }
  for (const edge of expect.edges ?? []) {
    if (!observed.edges?.includes(edge)) findings.push(`missing_edge:${edge}`);
  }
  return { passed: findings.length === 0, findings };
}

export function categoryPassRate(
  category: ScenarioCase['category'],
  results: Array<{ category: ScenarioCase['category']; passed: boolean }>,
): { rate: number; meetsFloor: boolean; floor: number } {
  const inCategory = results.filter((result) => result.category === category);
  const rate =
    inCategory.length === 0 ? 1 : inCategory.filter((r) => r.passed).length / inCategory.length;
  const floor = CATEGORY_PASS_FLOOR[category];
  return { rate, meetsFloor: rate >= floor, floor };
}
