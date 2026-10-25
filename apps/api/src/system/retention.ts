/**
 * Data-retention surface (FR-11.4, ADR-0021). The kernel deletes core rows and
 * invokes module-owned tasks for message bodies; this host route exposes the
 * configured windows and lets an operator trigger a pass on demand.
 */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';
import { DEFAULT_RETENTION } from '@triageai/kernel';

const CORE_TASKS = [
  'kernel.workflow_runs',
  'kernel.decision_records',
  'kernel.audit_events',
  'kernel.candidate_examples',
  'kernel.queue_deadletters',
];

export function registerRetentionRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/retention', async () => ({
    ...(kernel.config.retention ?? DEFAULT_RETENTION),
    coreTasks: CORE_TASKS,
    moduleTasks: 'registered by enabled modules (messages)',
  }));

  app.post('/api/v1/system/retention/run', async () => kernel.runRetention());
}
