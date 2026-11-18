import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApprovalStore, AutonomyLevelSchema, invalid } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { acceptAutonomyLevel, listFlowAutonomy, observeFlowRun } from '../services/approvals.js';
import { writeAudit } from '../services/audit.js';

const BatchDecisionSchema = z
  .object({
    ids: z.array(z.string().min(1).max(200)).min(1).max(200),
    outcome: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const AutonomyAcceptSchema = z
  .object({
    category: z.string().min(1).max(120).nullable().optional(),
    level: AutonomyLevelSchema,
  })
  .strict();

const FLOW_ID = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9_.]*$/);

export function registerApprovalRoutes(app: FastifyInstance, kernel: Kernel): void {
  const store = new ApprovalStore(kernel.database);

  // A flow reports an observed run (support auto-reply maps its decision
  // action onto the autonomy level); the host owns the settings table, so the
  // module publishes the observation instead of writing across schemas.
  kernel.events.subscribe('support.autonomy.observed', async (payload) => {
    const event = payload as {
      flow?: string;
      category?: string | null;
      action?: 'reply' | 'clarify' | 'escalate' | 'none';
    };
    if (event.flow !== 'support.auto_reply' || !event.action || event.action === 'none') return;
    await observeFlowRun(kernel.database, {
      flow: event.flow,
      category: event.category ?? null,
      action: event.action,
      by: 'system',
    }).catch(() => undefined);
  });

  app.get('/api/v1/approvals', async (request) => {
    const query = request.query as Record<string, string>;
    const status = (query.status ?? 'pending') as
      'pending' | 'approved' | 'rejected' | 'expired' | 'all';
    if (query.grouped === '1' || query.grouped === 'true') {
      const limit = Math.min(200, Math.max(1, Number(query.limit ?? 200) || 200));
      return { batches: await store.listBatches(status, limit) };
    }
    return store.list(status);
  });

  app.post('/api/v1/approvals/:id/approve', async (request) => {
    const reason = (request.body as { reason?: string } | undefined)?.reason;
    const approver = request.principal?.email ?? 'admin';
    const approval = await store.decide(
      (request.params as { id: string }).id,
      true,
      approver,
      reason,
    );
    await writeAudit(kernel.database, {
      actor: approver,
      action: 'approval.approved',
      subject: approval.id,
      payload: { runId: approval.runId, toolName: approval.toolName, reason: reason ?? null },
    });
    // A graph approval node parked the run AWAITING; resume along its
    // `approved` edge now that the human decision exists (18.3).
    await kernel.workflowEngine
      .resolveApproval(approval.runId, approval.id, 'approved', { approver, reason })
      .catch(() => undefined);
    return approval;
  });

  app.post('/api/v1/approvals/:id/reject', async (request) => {
    const reason = (request.body as { reason?: string } | undefined)?.reason;
    if (!reason) throw invalid('a rejection reason is required');
    const approver = request.principal?.email ?? 'admin';
    const approval = await store.decide(
      (request.params as { id: string }).id,
      false,
      approver,
      reason,
    );
    await writeAudit(kernel.database, {
      actor: approver,
      action: 'approval.rejected',
      subject: approval.id,
      payload: { runId: approval.runId, toolName: approval.toolName, reason },
    });
    await kernel.workflowEngine
      .resolveApproval(approval.runId, approval.id, 'rejected', { approver, reason })
      .catch(() => undefined);
    return approval;
  });

  // One decision for a batch, itemised: every row is decided and audited on
  // its own, but the whole subset is atomic (15.T9).
  app.post('/api/v1/approvals/batch', async (request) => {
    const body = BatchDecisionSchema.parse(request.body ?? {});
    if (body.outcome === 'reject' && !body.reason) {
      throw invalid('a rejection reason is required');
    }
    const approver = request.principal?.email ?? 'admin';
    const approvals = await store.decideBatch(body.ids, body.outcome, approver, body.reason);
    for (const approval of approvals) {
      await writeAudit(kernel.database, {
        actor: approver,
        action: body.outcome === 'approve' ? 'approval.approved' : 'approval.rejected',
        subject: approval.id,
        payload: {
          runId: approval.runId,
          toolName: approval.toolName,
          reason: approval.reason,
          batch: true,
        },
      });
      await kernel.workflowEngine
        .resolveApproval(
          approval.runId,
          approval.id,
          body.outcome === 'approve' ? 'approved' : 'rejected',
          { approver, reason: approval.reason ?? undefined },
        )
        .catch(() => undefined);
    }
    return { approvals };
  });

  // Per-flow autonomy state and the accepted promotion (15.T10).
  app.get('/api/v1/system/autonomy', async () => ({
    flows: await listFlowAutonomy(kernel.database),
  }));

  app.put('/api/v1/system/autonomy/:flow', async (request) => {
    const flow = FLOW_ID.parse((request.params as { flow: string }).flow);
    const body = AutonomyAcceptSchema.parse(request.body ?? {});
    return acceptAutonomyLevel(kernel.database, {
      flow,
      category: body.category ?? null,
      level: body.level,
      actor: request.principal?.email ?? null,
    });
  });
}
