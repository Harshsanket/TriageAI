/** Workflow definitions: `support.triage` and `support.auto_reply`. */
import type { ErrorCategory, KernelContext } from '@triageai/kernel';

/**
 * v1 `onError: 'fallback'` applied the workflow fallback policy to any stage
 * failure, so the declared error edge covers every 10C category. Other stages
 * keep the graph's default error edge (run FAILED), exactly like v1.
 */
const FALLBACK_ERROR_CATEGORIES: ErrorCategory[] = [
  'validation',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'dependency_unavailable',
  'timeout',
  'budget_exceeded',
  'policy_blocked',
  'internal',
];

export function registerWorkflows(ctx: KernelContext): void {
  // v2 graph (18.3/18.T20). The v1 `stages` list stays as the readable stage
  // trail (WORKFLOW.md) and compiles to the same flow; the engine executes the
  // graph. `classify`'s policy fallback is now the declared error edge to an
  // `escalated` end (AWAITING), with the policy recorded on the hop.
  ctx.queue.start({
    id: 'support.triage',
    module: 'support',
    version: '0.2.0',
    trigger: { type: 'endpoint' },
    fallbackPolicyId: 'escalate_human',
    graph: {
      id: 'support.triage',
      version: '0.2.0',
      module: 'support',
      trigger: { type: 'endpoint' },
      start: 'load',
      nodes: [
        {
          id: 'load',
          type: 'stage',
          kind: 'support.ticket.load',
          input: { ticketId: '$.ticketId' },
        },
        {
          id: 'classify',
          type: 'stage',
          kind: 'ai.classify',
          input: {
            subject: '${stages.load.output.subject}',
            body: '${stages.load.output.body}',
          },
        },
        {
          id: 'route',
          type: 'stage',
          kind: 'ai.route',
          input: {
            category: '${stages.classify.output.category}',
            safetyCritical: '${stages.classify.output.safetyCritical}',
            confidence: '${stages.classify.output.confidence}',
          },
        },
        {
          id: 'priority',
          type: 'stage',
          kind: 'support.triage.priority',
          input: {
            subject: '${stages.load.output.subject}',
            body: '${stages.load.output.body}',
            category: '${stages.classify.output.category}',
            safetyCritical: '${stages.classify.output.safetyCritical}',
          },
        },
        {
          id: 'team',
          type: 'stage',
          kind: 'support.triage.team',
          input: {
            category: '${stages.classify.output.category}',
            priorityCode: '${stages.priority.output.priorityCode}',
          },
        },
        {
          id: 'apply',
          type: 'stage',
          kind: 'support.ticket.apply',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            category: '${stages.classify.output.category}',
            confidence: '${stages.classify.output.confidence}',
            margin: '${stages.classify.output.margin}',
            method: '${stages.classify.output.method}',
            modelVersion: '${stages.classify.output.modelVersion}',
            reasonCodes: '${stages.classify.output.reasonCodes}',
            safetyCritical: '${stages.classify.output.safetyCritical}',
            team: '${stages.route.output.team}',
            priority: '${stages.route.output.priority}',
            escalate: '${stages.route.output.escalate}',
            ruleIds: '${stages.route.output.ruleIds}',
            rulesVersion: '${stages.route.output.rulesVersion}',
            routeReasons: '${stages.route.output.reasons}',
            priorityCode: '${stages.priority.output.priorityCode}',
            priorityAmbiguous: '${stages.priority.output.ambiguous}',
            priorityReasons: '${stages.priority.output.reasons}',
            teamId: '${stages.team.output.teamId}',
            teamAmbiguous: '${stages.team.output.ambiguous}',
            teamReasons: '${stages.team.output.reasons}',
          },
        },
        { id: 'end', type: 'end', end: 'succeeded' },
        { id: 'escalated', type: 'end', end: 'escalated' },
        { id: 'failed', type: 'end', end: 'failed' },
      ],
      edges: [
        { from: 'load', to: 'classify', label: 'next' },
        { from: 'classify', to: 'route', label: 'next' },
        { from: 'classify', to: 'escalated', label: 'fallback', on: FALLBACK_ERROR_CATEGORIES },
        { from: 'route', to: 'priority', label: 'next' },
        { from: 'priority', to: 'team', label: 'next' },
        { from: 'team', to: 'apply', label: 'next' },
        { from: 'apply', to: 'end', label: 'next' },
      ],
      defaultErrorEdge: { to: 'failed' },
      budget: { maxSteps: 20, maxDurationMs: 300_000 },
    },
    stages: [
      { id: 'load', kind: 'support.ticket.load', input: { ticketId: '$.ticketId' } },
      {
        id: 'classify',
        kind: 'ai.classify',
        input: {
          subject: '${stages.load.output.subject}',
          body: '${stages.load.output.body}',
        },
        config: {},
        onError: 'fallback',
      },
      {
        id: 'route',
        kind: 'ai.route',
        input: {
          category: '${stages.classify.output.category}',
          safetyCritical: '${stages.classify.output.safetyCritical}',
          confidence: '${stages.classify.output.confidence}',
        },
      },
      {
        id: 'priority',
        kind: 'support.triage.priority',
        input: {
          subject: '${stages.load.output.subject}',
          body: '${stages.load.output.body}',
          category: '${stages.classify.output.category}',
          safetyCritical: '${stages.classify.output.safetyCritical}',
        },
      },
      {
        id: 'team',
        kind: 'support.triage.team',
        input: {
          category: '${stages.classify.output.category}',
          priorityCode: '${stages.priority.output.priorityCode}',
        },
      },
      {
        id: 'apply',
        kind: 'support.ticket.apply',
        input: {
          ticketId: '${stages.load.output.ticketId}',
          category: '${stages.classify.output.category}',
          confidence: '${stages.classify.output.confidence}',
          margin: '${stages.classify.output.margin}',
          method: '${stages.classify.output.method}',
          modelVersion: '${stages.classify.output.modelVersion}',
          reasonCodes: '${stages.classify.output.reasonCodes}',
          safetyCritical: '${stages.classify.output.safetyCritical}',
          team: '${stages.route.output.team}',
          priority: '${stages.route.output.priority}',
          escalate: '${stages.route.output.escalate}',
          ruleIds: '${stages.route.output.ruleIds}',
          rulesVersion: '${stages.route.output.rulesVersion}',
          routeReasons: '${stages.route.output.reasons}',
          priorityCode: '${stages.priority.output.priorityCode}',
          priorityAmbiguous: '${stages.priority.output.ambiguous}',
          priorityReasons: '${stages.priority.output.reasons}',
          teamId: '${stages.team.output.teamId}',
          teamAmbiguous: '${stages.team.output.ambiguous}',
          teamReasons: '${stages.team.output.reasons}',
        },
      },
    ],
  });

  // v2 graph (18.3/18.T20). `when` skips become declared guard edges; the
  // generate policy fallback becomes the error edge to an `escalated` end
  // (AWAITING). load/policy/retrieve/validate/finalize/deliver failures keep
  // the default failed end, and the decision action still selects exactly one
  // of deliver | clarify | escalate (or none → end).
  ctx.queue.start({
    id: 'support.auto_reply',
    module: 'support',
    version: '0.2.0',
    trigger: { type: 'endpoint' },
    fallbackPolicyId: 'escalate_human',
    graph: {
      id: 'support.auto_reply',
      version: '0.2.0',
      module: 'support',
      trigger: { type: 'endpoint' },
      start: 'load',
      nodes: [
        {
          id: 'load',
          type: 'stage',
          kind: 'support.ticket.load',
          input: { ticketId: '$.ticketId' },
        },
        {
          id: 'policy',
          type: 'stage',
          kind: 'support.reply_policy',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            category: '${stages.load.output.category}',
          },
        },
        {
          id: 'retrieve',
          type: 'stage',
          kind: 'ai.retrieve',
          input: {
            query: '${stages.load.output.body}',
            collection: '${stages.policy.output.collection}',
            filter: { sourceEnabled: true },
            audience: 'public',
          },
        },
        {
          id: 'generate',
          type: 'stage',
          kind: 'ai.generate',
          input: {
            question: '${stages.load.output.body}',
            chunks: '${stages.retrieve.output.chunks}',
            style: 'assistant',
          },
          retry: { attempts: 2, backoffMs: [100] },
        },
        {
          id: 'validate',
          type: 'stage',
          kind: 'ai.validate',
          input: {
            answer: '${stages.generate.output.answer}',
            question: '${stages.load.output.body}',
            sources: '${stages.retrieve.output.chunks}',
            policy: '${stages.policy.output.validationPolicy}',
          },
        },
        {
          id: 'finalize',
          type: 'stage',
          kind: 'ai.finalize_answer',
          input: {
            answer: '${stages.generate.output.answer}',
            sources: '${stages.retrieve.output.chunks}',
          },
        },
        {
          id: 'decision',
          type: 'stage',
          kind: 'support.reply_decision',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            category: '${stages.policy.output.category}',
            enabled: '${stages.policy.output.enabled}',
            fallbackPolicy: '${stages.policy.output.fallbackPolicy}',
            sufficient: '${stages.retrieve.output.sufficient}',
            generated: '${stages.generate.output.answer}',
            passed: '${stages.validate.output.passed}',
            checks: '${stages.validate.output.checks}',
            answer: '${stages.finalize.output.answer}',
          },
        },
        {
          id: 'deliver',
          type: 'stage',
          kind: 'support.auto_reply_deliver',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            answer: '${stages.finalize.output.answer}',
            citations: '${stages.finalize.output.citations}',
            answerHash: '${stages.decision.output.answerHash}',
            policyVersion: '${stages.policy.output.policyVersion}',
          },
        },
        {
          id: 'clarify',
          type: 'stage',
          kind: 'support.auto_reply_clarify',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            reasons: '${stages.decision.output.reasons}',
          },
        },
        {
          id: 'escalate',
          type: 'stage',
          kind: 'support.auto_reply_escalate',
          input: {
            ticketId: '${stages.load.output.ticketId}',
            reasons: '${stages.decision.output.reasons}',
            checks: '${stages.validate.output.checks}',
          },
        },
        { id: 'end', type: 'end', end: 'succeeded' },
        { id: 'escalated', type: 'end', end: 'escalated' },
        { id: 'failed', type: 'end', end: 'failed' },
      ],
      edges: [
        { from: 'load', to: 'policy', label: 'next' },
        {
          from: 'policy',
          to: 'retrieve',
          label: 'enabled',
          when: '${stages.policy.output.enabled}',
        },
        { from: 'policy', to: 'decision', label: 'disabled' },
        {
          from: 'retrieve',
          to: 'generate',
          label: 'sufficient',
          when: '${stages.retrieve.output.sufficient}',
        },
        { from: 'retrieve', to: 'decision', label: 'insufficient' },
        {
          from: 'generate',
          to: 'validate',
          label: 'answered',
          when: '${stages.generate.output.answer}',
        },
        { from: 'generate', to: 'decision', label: 'empty_answer' },
        { from: 'generate', to: 'escalated', label: 'fallback', on: FALLBACK_ERROR_CATEGORIES },
        {
          from: 'validate',
          to: 'finalize',
          label: 'passed',
          when: '${stages.validate.output.passed}',
        },
        { from: 'validate', to: 'decision', label: 'not_passed' },
        { from: 'finalize', to: 'decision', label: 'next' },
        {
          from: 'decision',
          to: 'deliver',
          label: 'reply',
          when: "${stages.decision.output.action} == 'reply'",
        },
        {
          from: 'decision',
          to: 'clarify',
          label: 'clarify',
          when: "${stages.decision.output.action} == 'clarify'",
        },
        {
          from: 'decision',
          to: 'escalate',
          label: 'escalate',
          when: "${stages.decision.output.action} == 'escalate'",
        },
        { from: 'decision', to: 'end', label: 'none' },
        { from: 'deliver', to: 'end', label: 'next' },
        { from: 'clarify', to: 'end', label: 'next' },
        { from: 'escalate', to: 'end', label: 'next' },
      ],
      defaultErrorEdge: { to: 'failed' },
      budget: { maxSteps: 30, maxDurationMs: 300_000 },
    },
    stages: [
      {
        id: 'load',
        kind: 'support.ticket.load',
        input: { ticketId: '$.ticketId' },
      },
      {
        id: 'policy',
        kind: 'support.reply_policy',
        input: {
          ticketId: '${stages.load.output.ticketId}',
          category: '${stages.load.output.category}',
        },
      },
      {
        id: 'retrieve',
        kind: 'ai.retrieve',
        when: '${stages.policy.output.enabled}',
        input: {
          query: '${stages.load.output.body}',
          collection: '${stages.policy.output.collection}',
          filter: { sourceEnabled: true },
          audience: 'public',
        },
      },
      {
        id: 'generate',
        kind: 'ai.generate',
        when: '${stages.retrieve.output.sufficient}',
        input: {
          question: '${stages.load.output.body}',
          chunks: '${stages.retrieve.output.chunks}',
          style: 'assistant',
        },
        retry: { attempts: 2, backoffMs: [100] },
        onError: 'fallback',
      },
      {
        id: 'validate',
        kind: 'ai.validate',
        when: '${stages.generate.output.answer}',
        input: {
          answer: '${stages.generate.output.answer}',
          question: '${stages.load.output.body}',
          sources: '${stages.retrieve.output.chunks}',
          policy: '${stages.policy.output.validationPolicy}',
        },
      },
      {
        id: 'finalize',
        kind: 'ai.finalize_answer',
        when: '${stages.validate.output.passed}',
        input: {
          answer: '${stages.generate.output.answer}',
          sources: '${stages.retrieve.output.chunks}',
        },
      },
      {
        id: 'decision',
        kind: 'support.reply_decision',
        input: {
          ticketId: '${stages.load.output.ticketId}',
          category: '${stages.policy.output.category}',
          enabled: '${stages.policy.output.enabled}',
          fallbackPolicy: '${stages.policy.output.fallbackPolicy}',
          sufficient: '${stages.retrieve.output.sufficient}',
          generated: '${stages.generate.output.answer}',
          passed: '${stages.validate.output.passed}',
          checks: '${stages.validate.output.checks}',
          answer: '${stages.finalize.output.answer}',
        },
      },
      {
        id: 'deliver',
        kind: 'support.auto_reply_deliver',
        when: "${stages.decision.output.action} == 'reply'",
        input: {
          ticketId: '${stages.load.output.ticketId}',
          answer: '${stages.finalize.output.answer}',
          citations: '${stages.finalize.output.citations}',
          answerHash: '${stages.decision.output.answerHash}',
          policyVersion: '${stages.policy.output.policyVersion}',
        },
      },
      {
        id: 'clarify',
        kind: 'support.auto_reply_clarify',
        when: "${stages.decision.output.action} == 'clarify'",
        input: {
          ticketId: '${stages.load.output.ticketId}',
          reasons: '${stages.decision.output.reasons}',
        },
      },
      {
        id: 'escalate',
        kind: 'support.auto_reply_escalate',
        when: "${stages.decision.output.action} == 'escalate'",
        input: {
          ticketId: '${stages.load.output.ticketId}',
          reasons: '${stages.decision.output.reasons}',
          checks: '${stages.validate.output.checks}',
        },
      },
    ],
  });
}
