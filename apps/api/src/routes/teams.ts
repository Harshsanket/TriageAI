/** Team runs (Phase 17.T1): compile a topology to subworkflow nodes and start it. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { TeamRunInputSchema } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { listTeamRuns, startTeamRun } from '../services/agents.js';

const TeamRunBody = TeamRunInputSchema.extend({
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export function registerTeamRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/teams', async () => listTeamRuns(kernel));

  app.post('/api/v1/teams/run', async (request) => {
    const body = TeamRunBody.parse(request.body ?? {});
    const { idempotencyKey, ...input } = body;
    return startTeamRun(kernel, input, idempotencyKey ? { idempotencyKey } : {});
  });
}
