/**
 * Every HTTP surface the host mounts once the kernel has booted. Health routes
 * are registered earlier (they must answer before boot completes).
 */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

import type { DbModelRegistry } from '../services/modelRegistry.js';
import { registerAuditRoutes } from './audit.js';
import { registerCandidateRoutes } from './candidates.js';
import { registerDatasetRoutes } from './datasets.js';
import { registerHardwareRoute } from './hardware.js';
import { registerMetricsRoute } from './metrics.js';
import { registerModelRoutes } from './models.js';
import { registerModuleRoutes } from './modules.js';
import { registerRetentionRoutes } from './retention.js';
import { registerRunRoutes } from './runs.js';
import { registerSystemRoutes } from './system.js';

export interface HostRouteDeps {
  modelRegistry: DbModelRegistry;
}

export function registerHostRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  deps: HostRouteDeps,
): void {
  registerSystemRoutes(app, kernel);
  registerRunRoutes(app, kernel);
  registerMetricsRoute(app, kernel);
  registerAuditRoutes(app, kernel);
  registerCandidateRoutes(app, kernel);
  registerDatasetRoutes(app, kernel);
  registerModelRoutes(app, kernel, deps.modelRegistry);
  registerHardwareRoute(app, kernel);
  registerRetentionRoutes(app, kernel);
  registerModuleRoutes(app, kernel);
}
