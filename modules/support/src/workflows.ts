/** Workflow definitions: `support.triage` and `support.auto_reply`. */
import type { KernelContext } from '@triageai/kernel';

export function registerWorkflows(ctx: KernelContext): void {
  ctx.queue.start({
    id: 'support.triage',
    module: 'support',
    version: '0.1.0',
    trigger: { type: 'endpoint' },
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
      {
        id: 'dispatch',
        kind: 'support.dispatch_auto_reply',
        when: "${stages.apply.output.status} == 'ROUTED'",
        input: { ticketId: '${stages.load.output.ticketId}' },
      },
    ],
  });

  ctx.queue.start({
    id: 'support.auto_reply',
    module: 'support',
    version: '0.2.0',
    trigger: { type: 'endpoint' },
    fallbackPolicyId: 'escalate_human',
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
          filter: { approved: true },
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
