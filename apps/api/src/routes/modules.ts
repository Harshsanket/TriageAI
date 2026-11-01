/**
 * Module route dispatcher (Phase 12 soft-reload): one catch-all per method
 * resolves against the *current* kernel generation's routes, so installing,
 * enabling or disabling a plugin changes the surface without re-binding
 * Fastify routes. Host routes stay statically registered and win over the
 * wildcard in find-my-way.
 *
 * The host resolves identity here so modules stay auth-agnostic (ADR-0020).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { notFound } from '@triageai/kernel';
import type { Kernel, KernelRouteDef } from '@triageai/kernel';

function matches(pattern: string, path: string): boolean {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) => part.startsWith(':') || part === pathParts[index]);
}

function paramsFor(pattern: string, path: string): Record<string, string> {
  const result: Record<string, string> = {};
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  patternParts.forEach((part, index) => {
    if (part.startsWith(':') && pathParts[index] !== undefined) {
      result[part.slice(1)] = pathParts[index] as string;
    }
  });
  return result;
}

export function findModuleRoute(
  routes: KernelRouteDef[],
  method: string,
  path: string,
): KernelRouteDef | undefined {
  return routes.find((route) => route.method === method && matches(route.url, path));
}

export function registerModuleRoutes(
  app: FastifyInstance,
  getKernel: () => Kernel | undefined,
): void {
  const dispatch = async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const kernel = getKernel();
    if (!kernel) throw notFound('the kernel is not ready yet');
    const path = request.url.split('?')[0] ?? request.url;
    const route = findModuleRoute(kernel.routes(), request.method, path);
    if (!route)
      throw notFound(
        `Route ${request.method} ${path} not found (known: ${kernel
          .routes()
          .map((entry) => `${entry.method} ${entry.url}`)
          .join(', ')})`,
      );
    const result = await route.handler({
      method: request.method,
      url: path,
      params: paramsFor(route.url, path),
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
      role: request.principal?.role,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(',') : String(value ?? ''),
        ]),
      ),
      rawBody: request.rawBody,
    });
    if (route.contentType) {
      reply.header('content-type', route.contentType);
      reply.header('cache-control', 'no-cache');
      reply.header('x-accel-buffering', 'no');
    }
    return result;
  };

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/v1/*',
    handler: dispatch,
  });
  // OpenAI-compatible surfaces live outside `/api/v1` (Phase 13).
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/v1/*',
    handler: dispatch,
  });
}
