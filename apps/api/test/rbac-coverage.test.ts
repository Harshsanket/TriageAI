import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { Kernel, KernelContext, KernelRouteDef } from '@triageai/kernel';

import { MODULES } from '../src/app.js';
import { registerAuthRoutes } from '../src/platform/auth/index.js';
import type { AuthService } from '../src/platform/auth/service.js';
import { explicitRuleFor } from '../src/platform/auth/rbac.js';
import { registerHealthRoutes } from '../src/routes/health.js';
import { registerHostRoutes } from '../src/routes/index.js';
import type { DbModelRegistry } from '../src/services/modelRegistry.js';

/** Callable, infinitely deep no-op: stands in for every context service. */
function inert(): unknown {
  const fn = () => inert();
  return new Proxy(fn, { get: (_target, key) => (key === 'then' ? undefined : inert()) });
}

/**
 * Every route the host can mount — host surfaces plus every first-party
 * module, enabled or not — must have an explicit RBAC rule. The matrix is
 * deny-by-default, so a missing rule only means "admin-only by accident";
 * this test turns that accident into a deliberate decision (Phase 10B).
 */
describe('RBAC coverage', () => {
  it('has an explicit rule for every mountable route', async () => {
    const mounted: Array<{ method: string; url: string }> = [];
    const capture =
      (method: string) =>
      (url: string): void => {
        mounted.push({ method, url });
      };
    const fakeApp = new Proxy(
      {
        get: capture('GET'),
        post: capture('POST'),
        put: capture('PUT'),
        patch: capture('PATCH'),
        delete: capture('DELETE'),
        route: (opts: { method: string; url: string }) =>
          mounted.push({ method: opts.method, url: opts.url }),
      } as Record<string, unknown>,
      { get: (target, key: string) => target[key] ?? inert() },
    ) as unknown as FastifyInstance;

    const moduleRoutes: KernelRouteDef[] = [];
    for (const module of Object.values(MODULES)) {
      const ctx = new Proxy({} as Record<string, unknown>, {
        get: (_target, key) => {
          if (key === 'registerRoute') return (route: KernelRouteDef) => moduleRoutes.push(route);
          if (key === 'moduleOptions' || key === 'then') return undefined;
          if (key === 'env') return {};
          return inert();
        },
      }) as unknown as KernelContext;
      module.register(ctx);
    }
    const fakeKernel = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) => (key === 'routes' ? () => moduleRoutes : inert()),
    }) as unknown as Kernel;

    await registerHealthRoutes(fakeApp);
    registerAuthRoutes(fakeApp, inert() as AuthService, { mode: 'required' });
    registerHostRoutes(fakeApp, fakeKernel, { modelRegistry: inert() as DbModelRegistry });

    expect(moduleRoutes.length).toBeGreaterThan(30);
    const unruled = mounted
      .filter(({ method, url }) => !explicitRuleFor(method, url))
      .map(({ method, url }) => `${method} ${url}`);
    expect(unruled).toEqual([]);
  });
});
