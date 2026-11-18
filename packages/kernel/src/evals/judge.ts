/**
 * Online judge evaluation (Phase 18.1/18.T1).
 *
 * Deterministic sampling decides whether a run is judged; when it is, the judge
 * call goes through `callModel` with a structured output contract, a judge-tier
 * route, a 512-token output ceiling and a 30 s timeout. The judge is local by
 * default: run data is `internal` and the send gate withholds it from a hosted
 * model unless the caller explicitly supplies a non-hosted judge.
 */
import { z } from 'zod';

import { AppError } from '../errors.js';
import { callModel } from '../models/callModel.js';
import type { CallModelDeps, ModelCallTrace, ModelTask } from '../models/callModel.js';
import type { ChatModel, KernelLogger } from '../types.js';
import type { EvalScore } from './sampling.js';
import { shouldEvaluate } from './sampling.js';
import type { TrajectoryStep } from './trajectory.js';

export const JudgeOutputSchema = z
  .object({
    score: z.number().min(0).max(1),
    findings: z.array(z.string().min(1).max(500)).max(20),
    verdict: z.enum(['pass', 'fail']),
  })
  .strict();
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export interface JudgeRubric {
  id: string;
  version: string;
  /** Task-specific grading instructions appended to the judge system prompt. */
  instructions: string;
  /** Scores at or above this floor pass when the verdict is `pass`. */
  floor?: number;
}

export const DEFAULT_JUDGE_RUBRIC: JudgeRubric = {
  id: 'answer-quality',
  version: '1',
  instructions:
    'Score answer quality, task success, handoff completeness, tool-call efficiency and budget use. ' +
    'Use findings for concrete problems, not general praise.',
  floor: 0.8,
};

export const JUDGE_MAX_OUTPUT_TOKENS = 512;
export const JUDGE_TIMEOUT_MS = 30_000;

/** The model task every judge call uses (18.T1/18.T9). */
export function judgeTask(rubric: JudgeRubric = DEFAULT_JUDGE_RUBRIC): ModelTask {
  return {
    id: 'judge',
    promptTemplateId: `evals.judge.${rubric.id}`,
    promptVersion: rubric.version,
    outputSchema: JudgeOutputSchema,
    maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
    timeoutMs: JUDGE_TIMEOUT_MS,
    requiredFields: ['score', 'findings', 'verdict'],
  };
}

export interface JudgeInput {
  runId: string;
  workflowId: string;
  /** The stage/step being judged; defaults to the whole run. */
  stepName?: string;
  output: unknown;
  reference?: unknown;
  trajectory?: TrajectoryStep[];
  rubric?: JudgeRubric;
  /** 100% for hosted or high-risk runs (18.1); otherwise the base sample rate. */
  hostedModel?: boolean;
  highRiskTool?: boolean;
  baseRate?: number;
}

export interface JudgeDeps {
  chatModel: ChatModel;
  /** The judge-tier model; when absent the configured chat model is used. */
  judgeModel?: ChatModel;
  /** Explicit judge-tier resolver (wins over `judgeModel`). */
  resolveModel?: CallModelDeps['resolveModel'];
  logger?: KernelLogger;
  onTrace?: (trace: ModelCallTrace) => void | Promise<void>;
}

/**
 * Judge a sampled run. Returns `null` when deterministic sampling says this run
 * is not evaluated — the model is never called in that case.
 */
export async function judgeRun(deps: JudgeDeps, input: JudgeInput): Promise<EvalScore | null> {
  if (
    !shouldEvaluate(
      {
        runId: input.runId,
        ...(input.hostedModel !== undefined ? { hostedModel: input.hostedModel } : {}),
        ...(input.highRiskTool !== undefined ? { highRiskTool: input.highRiskTool } : {}),
      },
      input.baseRate ?? 0.1,
    )
  ) {
    return null;
  }

  const rubric = input.rubric ?? DEFAULT_JUDGE_RUBRIC;
  const task = judgeTask(rubric);
  const messages = [
    {
      role: 'system' as const,
      content:
        'You are the TriageAI evaluation judge. Grade only the supplied run evidence. ' +
        'Return JSON with exactly { "score": number 0..1, "findings": string[], "verdict": "pass" | "fail" }. ' +
        rubric.instructions,
    },
    {
      role: 'user' as const,
      content: JSON.stringify({
        runId: input.runId,
        workflowId: input.workflowId,
        stepName: input.stepName ?? null,
        output: input.output ?? null,
        reference: input.reference ?? null,
        trajectory: input.trajectory ?? [],
      }),
    },
  ];

  const callDeps: CallModelDeps = {
    chatModel: deps.chatModel,
    ...(deps.resolveModel
      ? { resolveModel: deps.resolveModel }
      : deps.judgeModel
        ? {
            resolveModel: () => ({
              chatModel: deps.judgeModel as ChatModel,
              reason: 'judge_tier',
            }),
          }
        : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
    ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
  };

  const result = await callModel(
    callDeps,
    task,
    {
      runId: input.runId,
      workflowId: input.workflowId,
      stepName: input.stepName ?? 'judge',
    },
    {
      messages,
      structured: true,
      temperature: 0,
      // Run evidence is internal; a hosted judge is withheld (18.8).
      sendGate: { sensitivity: 'internal', modelUse: 'local_only' },
    },
  );

  const parsed = JudgeOutputSchema.safeParse(result.parsed);
  if (!parsed.success) {
    throw new AppError(
      'eval.JUDGE_INVALID_OUTPUT',
      'judge output did not match the required score/findings/verdict shape',
      parsed.error.issues,
      502,
      { category: 'dependency_unavailable', retryable: false },
    );
  }

  const floor = rubric.floor ?? 0.8;
  return {
    runId: input.runId,
    evaluator: `judge.${rubric.id}@${rubric.version}`,
    method: 'judge',
    score: parsed.data.score,
    passed: parsed.data.verdict === 'pass' && parsed.data.score >= floor,
    floor,
    findings: parsed.data.findings,
  };
}

export interface SuspendOptions {
  /** Suspend after this many consecutive agreement scores below the floor. */
  consecutiveFailures?: number;
  /** Agreement floor (default 0.8). */
  floor?: number;
}

export type SuspendScore = number | { score: number; passed?: boolean; floor?: number };

/**
 * Judge-vs-human agreement gate (18.1): a judge that disagrees with reviewers
 * on `consecutiveFailures` consecutive items is suspended; deterministic
 * checks continue alone. Accepts raw agreement numbers or scored outcomes.
 */
export function shouldSuspend(scores: SuspendScore[], options: SuspendOptions = {}): boolean {
  const failures = options.consecutiveFailures ?? 3;
  if (failures <= 0) return false;
  const floor = options.floor ?? 0.8;
  if (scores.length < failures) return false;
  return scores.slice(-failures).every((entry) => {
    if (typeof entry === 'number') return !Number.isFinite(entry) || entry < floor;
    if (entry.passed === true) return false;
    if (entry.passed === false) return true;
    return !Number.isFinite(entry.score) || entry.score < (entry.floor ?? floor);
  });
}
