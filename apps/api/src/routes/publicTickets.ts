/**
 * 13.T1 ticket REST for public API keys. The host authenticates the key and
 * delegates to the support module's own registered route handler, so support
 * table access and business rules stay inside the support module.
 */
import type { FastifyInstance } from 'fastify';

import { notFound } from '@triageai/kernel';
import type { Kernel, KernelRouteDef } from '@triageai/kernel';

import { verifyPublicApiKey } from '../services/publicApiKeys.js';

function findRoute(kernel: Kernel, method: KernelRouteDef['method'], url: string) {
  const route = kernel
    .routes()
    .find((candidate) => candidate.method === method && candidate.url === url);
  if (!route) throw notFound(`support route ${method} ${url} is not registered`);
  return route;
}

export function registerPublicTicketRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.post('/api/v1/public-api/tickets', async (request) => {
    const key = await verifyPublicApiKey(kernel, request.headers.authorization, 'tickets');
    const route = findRoute(kernel, 'POST', '/api/v1/support/tickets');
    return route.handler({
      method: 'POST',
      url: '/api/v1/support/tickets',
      params: {},
      query: {},
      body: request.body ?? {},
      actor: `api-key:${key.id}`,
      actorId: key.id,
      role: 'agent',
    });
  });

  app.get('/api/v1/public-api/tickets', async (request) => {
    const key = await verifyPublicApiKey(kernel, request.headers.authorization, 'tickets');
    const route = findRoute(kernel, 'GET', '/api/v1/support/tickets');
    return route.handler({
      method: 'GET',
      url: '/api/v1/support/tickets',
      params: {},
      query: (request.query as Record<string, string>) ?? {},
      body: undefined,
      actor: `api-key:${key.id}`,
      actorId: key.id,
      role: 'agent',
    });
  });

  app.get('/api/v1/public-api/tickets/:id', async (request) => {
    const key = await verifyPublicApiKey(kernel, request.headers.authorization, 'tickets');
    const route = findRoute(kernel, 'GET', '/api/v1/support/tickets/:id');
    return route.handler({
      method: 'GET',
      url: '/api/v1/support/tickets/:id',
      params: request.params as Record<string, string>,
      query: {},
      body: undefined,
      actor: `api-key:${key.id}`,
      actorId: key.id,
      role: 'agent',
    });
  });
}
