/** `/agents` monitor (Phase 17.T2): definitions, live runs, steps, pause/resume. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { invalid, notFound } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import {
  createAgentDefinition,
  getAgent,
  listAgents,
  pauseAgent,
  promoteLesson,
  readAgentDefinition,
  resumeAgent,
  startAgentRun,
} from '../services/agents.js';

const PauseBody = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

const RunBody = z
  .object({
    goal: z.string().trim().min(1).max(4000),
    workspaceId: z.string().min(1).max(120).optional(),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

const AgentId = z.string().min(1).max(80);
const MemoryQuery = z.string().trim().min(1).max(300);

export function registerAgentRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/agents', async () => listAgents(kernel));

  app.post('/api/v1/agents', async (request) => {
    return createAgentDefinition(kernel, request.body ?? {}, request.principal?.email ?? 'admin');
  });

  app.get('/api/v1/agents/:id', async (request) => {
    const id = AgentId.parse((request.params as { id: string }).id);
    const rawQuery = (request.query as { memoryQuery?: unknown } | undefined)?.memoryQuery;
    const memoryQuery = rawQuery === undefined ? undefined : MemoryQuery.parse(rawQuery);
    const detail = await getAgent(kernel, id, memoryQuery === undefined ? {} : { memoryQuery });
    if (!detail) throw notFound(`agent ${id} not found`);
    return detail;
  });

  app.post('/api/v1/agents/:id/pause', async (request) => {
    const id = AgentId.parse((request.params as { id: string }).id);
    const body = PauseBody.parse(request.body ?? {});
    const actor = request.principal?.email ?? 'admin';
    return pauseAgent(kernel, id, actor, body.reason ?? 'operator paused');
  });

  app.post('/api/v1/agents/:id/resume', async (request) => {
    const id = AgentId.parse((request.params as { id: string }).id);
    const body = PauseBody.parse(request.body ?? {});
    const actor = request.principal?.email ?? 'admin';
    return resumeAgent(kernel, id, actor, body.reason ?? 'operator resumed');
  });

  app.post('/api/v1/agents/:id/run', async (request) => {
    const id = AgentId.parse((request.params as { id: string }).id);
    const body = RunBody.parse(request.body ?? {});
    const definition = await readAgentDefinition(kernel, id);
    if (!definition) throw notFound(`agent definition ${id} not found`);
    if (!definition.tools.every((tool) => kernel.tools.get(tool))) {
      throw invalid('the agent definition names a tool that is not registered');
    }
    return startAgentRun(
      kernel,
      {
        definition,
        goal: body.goal,
        agentId: id,
        ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
      },
      body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {},
    );
  });

  app.post('/api/v1/agents/:id/memory/:memoryId/promote', async (request) => {
    const id = AgentId.parse((request.params as { id: string }).id);
    const memoryId = AgentId.parse((request.params as { memoryId: string }).memoryId);
    const body = z
      .object({ target: z.enum(['skill', 'profile']) })
      .strict()
      .parse(request.body ?? {});
    return promoteLesson(kernel, {
      memoryId,
      target: body.target,
      actor: request.principal?.email ?? 'admin',
      agentId: id,
    });
  });
}
