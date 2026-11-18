/**
 * Scenario regression suite (Phase 18.T27).
 *
 * Loads the authored scenario fixtures for the shipped surfaces (chat answer,
 * support auto-reply, doc-assistant), drives the deterministic pipeline pieces
 * with fixture-authored provider/tool payloads, grades every case with
 * `gradeScenario`, and enforces each category's floor from
 * `CATEGORY_PASS_FLOOR`. No live model or network call is made.
 *
 *   pnpm --filter @triageai/api exec tsx evals/scenarios.eval.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  CATEGORY_PASS_FLOOR,
  ChatSendMessageRequestSchema,
  ScenarioCaseSchema,
} from '@triageai/contracts';
import type { ScenarioCase, ScenarioCategory } from '@triageai/contracts';
import {
  categoryPassRate,
  classifySend,
  gateIntent,
  gradeScenario,
  sanitizeModelText,
  scopeMessage,
} from '@triageai/kernel';
import type {
  ChatModel,
  ChatResponse,
  IntentDecision,
  IntentScope,
  ScenarioObservation,
} from '@triageai/kernel';
import { detect, finalizeAnswer, runValidation } from '@triageai/rag';
import type { FinalizedAnswer, ValidationReport } from '@triageai/rag';

// Drive the real support decision stage rather than a copy of its policy
// table, so a change to the shipped fallback rules is caught by this gate.
import { registerAutoReplyStages } from '../../../modules/support/src/stages/autoReply.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'scenarios');
const REPORTS_DIR = path.join(HERE, 'reports');
const REFUSAL = 'I could not verify this from the knowledge base.';
const DOC_REFUSAL = 'That is not documented (yet).';
const MIN_CASES_PER_CATEGORY = 5;

const ScenarioFileSchema = z
  .object({ version: z.literal(1), cases: z.array(ScenarioCaseSchema) })
  .strict();

const ScopeDecisionSchema = z
  .object({
    intent: z.string().min(1),
    inScope: z.boolean(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const ScenarioInputSchema = z
  .object({
    surface: z.enum(['chat', 'support', 'doc_assistant']),
    question: z.string(),
    request: z.unknown().optional(),
    scopeDecision: ScopeDecisionSchema.optional(),
    hosted: z.boolean().default(false),
  })
  .strict();

const PolicySchema = z
  .object({
    knowledgeMode: z.enum(['prefer', 'only']).default('prefer'),
    groundingThreshold: z.number().min(0).max(1).optional(),
    maxAnswerChars: z.number().int().positive().default(1200),
    enabled: z.boolean().default(true),
    fallbackPolicy: z
      .enum([
        'request_clarification',
        'return_uncertain',
        'escalate_human',
        'halt_run',
        'retry_alternative_retrieval',
      ])
      .default('escalate_human'),
    reason: z
      .enum(['enabled', 'disabled', 'capabilities_missing', 'no_policy', 'category_missing'])
      .default('enabled'),
  })
  .strict();

const SourceSchema = z.object({ ref: z.string().min(1), text: z.string().min(1) }).strict();
const RetrievalSchema = z
  .object({ sufficient: z.boolean(), failed: z.boolean() })
  .strict()
  .default({ sufficient: true, failed: false });
const GeneratedSchema = z
  .object({ text: z.string(), modelVersion: z.string().optional() })
  .strict();

const FixturesSchema = z
  .object({
    sources: z.array(SourceSchema).default([]),
    generated: GeneratedSchema.nullable().optional(),
    retrieval: RetrievalSchema,
    generationFailed: z.boolean().default(false),
    policy: PolicySchema.optional(),
  })
  .strict();

const ChatAnswerSchema = z
  .object({ answer: z.string(), refused: z.boolean(), citations: z.array(z.string()) })
  .strict();
const DocAnswerSchema = ChatAnswerSchema;
const SupportAutoReplySchema = z
  .object({
    action: z.enum(['reply', 'clarify', 'escalate', 'none']),
    answer: z.string().nullable(),
    citations: z.array(z.string()),
    status: z.enum(['AWAITING_CUSTOMER', 'HUMAN_REVIEW', 'UNCHANGED']),
  })
  .strict();

const SupportTicketRequestSchema = z
  .object({
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000),
    requester: z.string().min(1).max(200).default('customer'),
    idempotencyKey: z.string().min(1).max(200).optional(),
    orgId: z.string().optional(),
  })
  .strict();

const DocAskRequestSchema = z
  .object({
    question: z.string().min(1).max(4000),
    limit: z.number().int().positive().max(10).default(5),
  })
  .strict();

type ScenarioInput = z.infer<typeof ScenarioInputSchema>;
type Fixtures = z.infer<typeof FixturesSchema>;

const CHAT_SCOPE: IntentScope = {
  id: 'chat',
  intents: {
    product_help: {
      keywords: ['password', 'login', 'account', 'billing', 'invoice', 'refund', 'reset', 'export'],
    },
    general: { keywords: ['hello', 'hi', 'thanks'] },
  },
  outOfScopeExamples: ['Write me a poem', 'Book a meeting with support tomorrow'],
  refusalMessage: REFUSAL,
  clarifyMessage: 'Could you share a bit more detail so I can answer precisely?',
  maxChars: 20_000,
};

interface ObservationResult {
  observation: ScenarioObservation;
  details: Record<string, unknown>;
}

interface GradedResult {
  scenario: ScenarioCase;
  observation: ScenarioObservation;
  details: Record<string, unknown>;
  passed: boolean;
  findings: string[];
}

function fixtureModel(content: string): ChatModel {
  return {
    async chat(): Promise<ChatResponse> {
      return {
        message: { role: 'assistant', content },
        toolCalls: [],
        usage: { inputTokens: 32, outputTokens: 8 },
        stopReason: 'end',
        modelVersion: 'fixture-small@1',
      };
    },
    describe() {
      return {
        provider: 'fixture',
        model: 'fixture-small',
        hosted: false,
        contextWindow: 8192,
        maxOutput: 64,
        supportsTools: false,
        supportsStreaming: false,
      };
    },
  };
}

async function chatDecision(input: ScenarioInput, question: string): Promise<IntentDecision> {
  if (!input.scopeDecision) return gateIntent({ scope: CHAT_SCOPE, text: question });
  return gateIntent({
    scope: CHAT_SCOPE,
    text: question,
    model: { chatModel: fixtureModel(JSON.stringify(input.scopeDecision)) },
    context: { runId: 'scenario:chat', workflowId: 'chat.reply', stepName: 'scope' },
  });
}

function rejected(): ObservationResult {
  return {
    observation: { edges: ['request_rejected'], toolsCalled: [] },
    details: { rejected: true },
  };
}

function validationDetails(
  report: ValidationReport | undefined,
): { passed: boolean; failedChecks: string[] } | null {
  if (!report) return null;
  return {
    passed: report.passed,
    failedChecks: report.checks.filter((check) => !check.passed).map((check) => check.checkId),
  };
}

async function observeChat(input: ScenarioInput, fixtures: Fixtures): Promise<ObservationResult> {
  const request = ChatSendMessageRequestSchema.safeParse(input.request ?? { text: input.question });
  if (!request.success) return rejected();
  const question = request.data.text;
  const decision = await chatDecision(input, question);
  const gateUnavailable =
    decision.reason === 'rules_undecided_no_model' || decision.reason === 'model_unavailable';
  const edges = ['request_accepted', 'scope_gate'];
  const toolsCalled: string[] = [];
  let refused = false;
  let clarifyingQuestion = false;
  let answer = '';
  let citations: string[] = [];
  let output: unknown;
  let validation: ValidationReport | undefined;

  if (decision.action !== 'allow' && !gateUnavailable) {
    refused = true;
    clarifyingQuestion = decision.action === 'clarify';
    edges.push(clarifyingQuestion ? 'scope_clarify' : 'scope_refused', 'deliver');
    answer = scopeMessage(CHAT_SCOPE, decision);
    output = { answer, refused, citations: [] };
  } else {
    const policy = fixtures.policy ?? PolicySchema.parse({});
    const retrieval = fixtures.retrieval;
    const generated = fixtures.generated?.text ? sanitizeModelText(fixtures.generated.text) : null;
    const direct = retrieval.failed || (!retrieval.sufficient && policy.knowledgeMode === 'prefer');

    if (retrieval.failed) {
      edges.push('retrieve_failed', 'fallback_direct');
      toolsCalled.push('kb.search');
    } else {
      edges.push('retrieve');
      toolsCalled.push('kb.search');
      if (!retrieval.sufficient) edges.push('retrieve_insufficient');
    }

    if (!direct && !retrieval.sufficient) {
      edges.push('gate_blocked', 'deliver_refusal');
      refused = true;
      answer = REFUSAL;
      output = { answer, refused, citations: [] };
    } else {
      if (!retrieval.failed && !retrieval.sufficient) edges.push('fallback_direct');
      if (!generated || fixtures.generationFailed) {
        edges.push('generate_failed', 'deliver_refusal');
        refused = true;
        answer = REFUSAL;
        output = { answer, refused, citations: [] };
      } else {
        edges.push('generate');
        validation = runValidation(
          { text: generated, sources: fixtures.sources, question },
          {
            maxChars: 8000,
            groundingThreshold: policy.groundingThreshold ?? 0.6,
            allowUngrounded: direct,
          },
        );
        if (!validation.passed) {
          edges.push('validate', 'validation_failed', 'deliver_refusal');
          refused = true;
          answer = REFUSAL;
          output = { answer, refused, citations: [] };
        } else if (direct) {
          edges.push('validate', 'deliver');
          refused = false;
          answer = generated;
          output = { answer, refused, citations: [] };
        } else {
          const finalized = finalizeAnswer({
            answer: generated,
            sources: fixtures.sources,
            threshold: policy.groundingThreshold ?? 0.6,
          });
          edges.push('validate', 'finalize');
          if (finalized.refused) {
            edges.push('finalize_refused', 'deliver_refusal');
            refused = true;
            answer = REFUSAL;
            output = { answer, refused, citations: [] };
          } else {
            edges.push('deliver');
            if (finalized.citations.length > 0) edges.push('citation_attached');
            refused = false;
            answer = finalized.answer;
            citations = finalized.citations;
            output = { answer, refused, citations };
          }
        }
      }
    }
  }

  const outputValid = ChatAnswerSchema.safeParse(output).success;
  return {
    observation: { edges, toolsCalled, refused, clarifyingQuestion, outputValid },
    details: { decision, validation: validationDetails(validation), answer, citations },
  };
}

type SupportStageHandler = {
  execute(stage: { input?: unknown; runId?: string }): Promise<unknown>;
};

const supportStages = new Map<string, SupportStageHandler>();
const supportCtx = {
  registerStageHandler: (kind: string, handler: SupportStageHandler) =>
    supportStages.set(kind, handler),
  database: { query: async () => [] },
  capabilities: {},
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
};
registerAutoReplyStages(
  supportCtx as unknown as Parameters<typeof registerAutoReplyStages>[0],
  {
    defaultCollection: 'kb_docs',
    defaultMaxAnswerChars: 1200,
  } as unknown as Parameters<typeof registerAutoReplyStages>[1],
  {
    hashAnswer: (answer: string) => `fixture:${answer.length}`,
  } as unknown as Parameters<typeof registerAutoReplyStages>[2],
);

const DecisionOutputSchema = z
  .object({
    action: z.enum(['none', 'reply', 'clarify', 'escalate']),
    reasons: z.array(z.string()),
  })
  .passthrough();

async function supportDecision(
  input: Record<string, unknown>,
): Promise<z.infer<typeof DecisionOutputSchema>> {
  const handler = supportStages.get('support.reply_decision');
  if (!handler) throw new Error('support.reply_decision was not registered');
  const result = (await handler.execute({ input, runId: 'scenario:support' })) as {
    output?: unknown;
  };
  return DecisionOutputSchema.parse(result.output);
}

async function observeSupport(
  input: ScenarioInput,
  fixtures: Fixtures,
): Promise<ObservationResult> {
  const request = SupportTicketRequestSchema.safeParse(
    input.request ?? { subject: 'Support request', body: input.question },
  );
  if (!request.success) return rejected();
  const body = request.data.body;
  const policy = fixtures.policy ?? PolicySchema.parse({});
  const retrieval = fixtures.retrieval;
  const generated = fixtures.generated?.text ? sanitizeModelText(fixtures.generated.text) : null;
  const sufficient = retrieval.sufficient && !retrieval.failed;
  const edges = ['request_accepted', 'policy'];
  const toolsCalled: string[] = [];
  let validation: ValidationReport | undefined;
  let finalized: FinalizedAnswer | undefined;

  if (policy.enabled) {
    edges.push('retrieve');
    toolsCalled.push('kb.search');
    if (retrieval.failed) edges.push('retrieve_failed');
    if (!sufficient) edges.push('retrieve_insufficient');
    if (sufficient) {
      if (!generated || fixtures.generationFailed) {
        edges.push('generate_failed');
      } else {
        edges.push('generate');
        validation = runValidation(
          { text: generated, sources: fixtures.sources, question: body },
          { maxChars: policy.maxAnswerChars, groundingThreshold: 0.6 },
        );
        edges.push('validate');
        if (!validation.passed) {
          edges.push('validation_failed');
        } else {
          finalized = finalizeAnswer({
            answer: generated,
            sources: fixtures.sources,
            threshold: 0.6,
          });
          edges.push('finalize');
          if (finalized.refused) edges.push('finalize_refused');
        }
      }
    }
  } else {
    edges.push('policy_disabled');
    if (policy.reason === 'capabilities_missing') edges.push('capabilities_missing');
  }

  const decision = await supportDecision({
    ticketId: 'ticket-scenario',
    enabled: policy.enabled,
    fallbackPolicy: policy.fallbackPolicy,
    sufficient,
    generated: generated ?? undefined,
    passed: validation?.passed,
    checks: validation?.checks,
    answer: finalized && !finalized.refused ? finalized.answer : undefined,
  });
  let action = decision.action;
  let answer: string | null = null;
  let citations: string[] = [];
  // The state is the transition implied by the shipped decision stage; DB
  // persistence of that transition is covered by the support module tests.
  let status: 'AWAITING_CUSTOMER' | 'HUMAN_REVIEW' | 'UNCHANGED' = 'UNCHANGED';
  let refused = true;
  let clarifyingQuestion = false;
  edges.push('decision');

  if (action === 'reply') {
    if (!finalized || finalized.refused) {
      action = 'escalate';
      edges.push('escalate', 'state_human_review');
      status = 'HUMAN_REVIEW';
    } else {
      edges.push('reply', 'state_awaiting_customer');
      if (finalized.citations.length > 0) edges.push('citation_attached');
      answer = finalized.answer;
      citations = finalized.citations;
      status = 'AWAITING_CUSTOMER';
      refused = false;
    }
  } else if (action === 'clarify') {
    edges.push('clarify', 'state_awaiting_customer');
    status = 'AWAITING_CUSTOMER';
    clarifyingQuestion = true;
  } else if (action === 'escalate') {
    edges.push('escalate', 'state_human_review');
    status = 'HUMAN_REVIEW';
  } else {
    edges.push('no_reply');
  }

  const output = { action, answer, citations, status };
  const outputValid = SupportAutoReplySchema.safeParse(output).success;
  return {
    observation: { edges, toolsCalled, refused, clarifyingQuestion, outputValid },
    details: { decision, validation: validationDetails(validation), answer, citations, status },
  };
}

async function observeDoc(input: ScenarioInput, fixtures: Fixtures): Promise<ObservationResult> {
  const request = DocAskRequestSchema.safeParse(input.request ?? { question: input.question });
  if (!request.success) return rejected();
  const question = request.data.question;
  const detection = detect(question);
  const gate = classifySend({
    sensitivity: detection.hasSecret ? 'secret' : 'internal',
    hosted: input.hosted,
    tags: detection.tags,
  });
  const edges = ['request_accepted', 'send_gate'];
  const toolsCalled: string[] = [];
  const policy = fixtures.policy ?? PolicySchema.parse({});
  const retrieval = fixtures.retrieval;
  let refused = true;
  let answer = DOC_REFUSAL;
  let citations: string[] = [];
  let output: unknown;
  let validation: ValidationReport | undefined;

  if (gate.decision === 'withheld') {
    edges.push('send_gate_withheld', 'refuse');
    output = { answer, refused, citations: [] };
  } else {
    edges.push('retrieve');
    toolsCalled.push('kb.search');
    if (!retrieval.sufficient || retrieval.failed) {
      edges.push('retrieve_insufficient', 'refuse');
      output = { answer, refused, citations: [] };
    } else {
      const generated = fixtures.generated?.text
        ? sanitizeModelText(fixtures.generated.text)
        : null;
      if (!generated || fixtures.generationFailed) {
        edges.push('generate_failed', 'refuse');
        output = { answer, refused, citations: [] };
      } else {
        edges.push('generate');
        validation = runValidation(
          { text: generated, sources: fixtures.sources, question },
          { maxChars: 8000, groundingThreshold: policy.groundingThreshold ?? 0.45 },
        );
        if (!validation.passed) {
          edges.push('validate', 'validation_failed', 'refuse');
          output = { answer, refused, citations: [] };
        } else {
          const finalized = finalizeAnswer({
            answer: generated,
            sources: fixtures.sources,
            threshold: policy.groundingThreshold ?? 0.45,
          });
          edges.push('validate', 'finalize');
          if (finalized.refused) {
            edges.push('finalize_refused', 'refuse');
            output = { answer, refused, citations: [] };
          } else {
            edges.push('deliver');
            if (finalized.citations.length > 0) edges.push('citation_attached');
            refused = false;
            answer = finalized.answer;
            citations = finalized.citations;
            output = { answer, refused, citations };
          }
        }
      }
    }
  }

  const outputValid = DocAnswerSchema.safeParse(output).success;
  return {
    observation: { edges, toolsCalled, refused, clarifyingQuestion: false, outputValid },
    details: { gate, detection, validation: validationDetails(validation), answer, citations },
  };
}

async function observe(input: ScenarioInput, fixtures: Fixtures): Promise<ObservationResult> {
  if (input.surface === 'chat') return observeChat(input, fixtures);
  if (input.surface === 'support') return observeSupport(input, fixtures);
  return observeDoc(input, fixtures);
}

async function loadCases(): Promise<ScenarioCase[]> {
  const files = ['chat.json', 'support.json', 'doc-assistant.json'];
  const cases: ScenarioCase[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(path.join(FIXTURE_DIR, file), 'utf8')) as unknown;
    const parsed = ScenarioFileSchema.parse(raw);
    cases.push(...parsed.cases);
  }
  return cases;
}

async function main(): Promise<number> {
  const scenarios = await loadCases();
  const results: GradedResult[] = [];

  for (const scenario of scenarios) {
    try {
      const input = ScenarioInputSchema.parse(scenario.input);
      const fixtures = FixturesSchema.parse(scenario.fixtures ?? {});
      const observed = await observe(input, fixtures);
      const graded = gradeScenario(scenario, observed.observation);
      results.push({ scenario, ...observed, passed: graded.passed, findings: graded.findings });
    } catch (error) {
      results.push({
        scenario,
        observation: {},
        details: { error: (error as Error).message },
        passed: false,
        findings: ['fixture_invalid'],
      });
    }
  }

  const categories = Object.keys(CATEGORY_PASS_FLOOR) as ScenarioCategory[];
  const categoryRows = categories.map((category) => {
    const inCategory = results.filter((result) => result.scenario.category === category);
    const rate = categoryPassRate(
      category,
      results.map((result) => ({
        category: result.scenario.category,
        passed: result.passed,
      })),
    );
    return {
      category,
      cases: inCategory.length,
      passed: inCategory.filter((result) => result.passed).length,
      ...rate,
      meetsMinimum: inCategory.length >= MIN_CASES_PER_CATEGORY,
    };
  });

  const total = results.length;
  const passedCases = results.filter((result) => result.passed).length;
  const categoriesMet = categoryRows.filter((row) => row.meetsFloor && row.meetsMinimum).length;
  // Floors are rates, not zero-failure gates: malicious, invalid input and
  // policy edge floors are 1; the rest default to 0.9.
  const status = total > 0 && categoriesMet === categories.length ? 'passed' : 'failed';
  const metrics = {
    passRate: total === 0 ? 0 : Number((passedCases / total).toFixed(4)),
    categoriesMet,
    categories: categories.length,
    scenarioCases: total,
  };
  const gates = { ...CATEGORY_PASS_FLOOR, minCasesPerCategory: MIN_CASES_PER_CATEGORY };

  const report = {
    generatedAt: new Date().toISOString(),
    suite: 'scenarios',
    status,
    cases: total,
    metrics,
    gates,
    categories: categoryRows,
    results: results.map((result) => ({
      id: result.scenario.id,
      target: result.scenario.target,
      category: result.scenario.category,
      passed: result.passed,
      findings: result.findings,
      edges: result.observation.edges ?? [],
      toolsCalled: result.observation.toolsCalled ?? [],
      refused: result.observation.refused ?? null,
      clarifyingQuestion: result.observation.clarifyingQuestion ?? null,
      outputValid: result.observation.outputValid ?? null,
      details: result.details,
    })),
  };

  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(
    path.join(REPORTS_DIR, 'scenarios-latest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  console.log('category       cases  passed  rate   floor  minimum  status');
  for (const row of categoryRows) {
    console.log(
      `${row.category.padEnd(14)} ${String(row.cases).padStart(5)}  ${String(row.passed).padStart(6)}  ${row.rate.toFixed(2)}   ${row.floor.toFixed(2)}   ${row.meetsMinimum ? 'yes' : 'no '}      ${row.meetsFloor && row.meetsMinimum ? 'ok' : 'FAIL'}`,
    );
  }
  console.log(
    JSON.stringify({ suite: 'scenarios', status, metrics, failed: total - passedCases }, null, 2),
  );

  for (const result of results.filter((entry) => !entry.passed)) {
    console.error(`FAIL ${result.scenario.id}: ${result.findings.join(', ')}`);
  }

  if (status !== 'passed') {
    console.error('GATE FAILURE: scenario suite breached a category floor or fixture minimum');
    return 1;
  }
  return 0;
}

void main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
