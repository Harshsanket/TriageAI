/**
 * Every HTTP surface the host mounts once the kernel has booted. Health routes
 * are registered earlier (they must answer before boot completes).
 */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

import type { DbModelRegistry } from '../services/modelRegistry.js';
import { registerSetupRoutes, type SetupRouteDeps } from '../setup/routes.js';
import { registerAlertRoutes } from './alerts.js';
import { registerApprovalRoutes } from './approvals.js';
import { registerAuditRoutes } from './audit.js';
import { registerCandidateRoutes } from './candidates.js';
import { registerConnectionRoutes } from './connections.js';
import { registerDashboardRoutes } from './dashboard.js';
import { registerEventRoutes } from './events.js';
import { registerDatasetRoutes } from './datasets.js';
import { registerDeadLetterRoutes } from './deadletters.js';
import { registerHardwareRoute } from './hardware.js';
import { registerJobRoutes } from './jobs.js';
import { registerMcpRoutes } from './mcp.js';
import { registerMetricsRoute } from './metrics.js';
import { registerModelRoutes } from './models.js';
import { registerModuleRoutes } from './modules.js';
import { registerPluginRoutes, type PluginRouteDeps } from './plugins.js';
import { registerPreferenceRoutes } from './preferences.js';
import { registerRetentionRoutes } from './retention.js';
import { registerSkillRoutes } from './skills.js';
import { registerRunRoutes } from './runs.js';
import { registerSystemRoutes } from './system.js';
import { registerUpdateRoutes } from './update.js';

export interface HostRouteDeps {
  modelRegistry: DbModelRegistry;
  setup: SetupRouteDeps;
  plugins: PluginRouteDeps;
}

export function registerHostRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  deps: HostRouteDeps,
): void {
  registerSystemRoutes(app, kernel, deps.setup.runtime);
  registerUpdateRoutes(app, kernel);
  registerPreferenceRoutes(app, kernel);
  registerDashboardRoutes(app, kernel, deps.setup.runtime);
  registerConnectionRoutes(app, kernel, deps.setup.runtime);
  registerEventRoutes(app, kernel);
  registerJobRoutes(app, kernel);
  registerSetupRoutes(app, kernel, deps.setup);
  registerRunRoutes(app, kernel);
  registerDeadLetterRoutes(app, kernel);
  registerMetricsRoute(app, kernel);
  registerMcpRoutes(app, kernel);
  registerAuditRoutes(app, kernel);
  registerApprovalRoutes(app, kernel);
  registerAlertRoutes(app, kernel);
  registerCandidateRoutes(app, kernel);
  registerDatasetRoutes(app, kernel);
  registerModelRoutes(app, kernel, deps.modelRegistry);
  registerHardwareRoute(app, kernel);
  registerRetentionRoutes(app, kernel);
  registerSkillRoutes(app, kernel);
  registerPluginRoutes(app, kernel, deps.plugins);
  registerModuleRoutes(app, () => app.kernel);
}
