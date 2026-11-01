import type { FastifyInstance } from 'fastify';

import { invalid } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { ApprovalStore } from '@triageai/kernel';

export function registerApprovalRoutes(app: FastifyInstance, kernel: Kernel): void {
  const store = new ApprovalStore(kernel.database);
  app.get('/api/v1/approvals', async (request) => {
    const status = ((request.query as Record<string, string>).status ?? 'pending') as
      'pending' | 'approved' | 'rejected' | 'expired' | 'all';
    return store.list(status);
  });
  app.post('/api/v1/approvals/:id/approve', async (request) => {
    const reason = (request.body as { reason?: string } | undefined)?.reason;
    return store.decide(
      (request.params as { id: string }).id,
      true,
      request.principal?.email ?? 'admin',
      reason,
    );
  });
  app.post('/api/v1/approvals/:id/reject', async (request) => {
    const reason = (request.body as { reason?: string } | undefined)?.reason;
    if (!reason) throw invalid('a rejection reason is required');
    return store.decide(
      (request.params as { id: string }).id,
      false,
      request.principal?.email ?? 'admin',
      reason,
    );
  });
}
