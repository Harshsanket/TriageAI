/**
 * Mounts module routes registered through `ctx.registerRoute`, translating the
 * Fastify request into the kernel's transport-neutral `RouteRequest`. The host
 * resolves identity here so modules stay auth-agnostic (ADR-0020).
 */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

export function registerModuleRoutes(app: FastifyInstance, kernel: Kernel): void {
  for (const route of kernel.routes()) {
    app.route({
      method: route.method,
      url: route.url,
      handler: async (request) =>
        route.handler({
          method: request.method,
          url: request.url.split('?')[0] ?? request.url,
          params: (request.params ?? {}) as Record<string, string>,
          query: Object.fromEntries(
            Object.entries((request.query ?? {}) as Record<string, unknown>).map(([k, v]) => [
              k,
              typeof v === 'string' ? v : String(v ?? ''),
            ]),
          ),
          body: request.body,
          actor: request.principal?.email,
          actorId: request.principal?.userId,
          // Customers only ever see their own records (ADR-0020 amendment).
          ownerScope: request.principal?.role === 'customer' ? request.principal.userId : undefined,
          headers: Object.fromEntries(
            Object.entries(request.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(',') : String(value ?? ''),
            ]),
          ),
          rawBody: request.rawBody,
        }),
    });
  }
}
