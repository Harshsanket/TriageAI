/**
 * Role-based access policy for the API surface (FR-11.1). Rules are ordered:
 * the first match wins. Anything unmatched is admin-only (deny by default).
 */
import type { Role } from './tokens.js';

export interface RouteRule {
  method: string;
  pattern: string;
  roles: Role[] | 'public' | 'key';
}

const ADMIN: Role[] = ['admin'];
const AGENT: Role[] = ['agent', 'admin'];
const ANY: Role[] = ['customer', 'agent', 'admin'];

/**
 * Ownership ACLs are not represented here: customer-facing reads are limited to
 * their own idempotency scope in a follow-up (recorded in ADR-0020).
 */
export const ROUTE_RULES: RouteRule[] = [
  { method: 'GET', pattern: '/healthz', roles: 'public' },
  { method: 'GET', pattern: '/readyz', roles: 'public' },
  { method: 'POST', pattern: '/api/v1/auth/login', roles: 'public' },
  { method: 'POST', pattern: '/api/v1/auth/register', roles: 'public' },
  { method: 'POST', pattern: '/api/v1/auth/refresh', roles: 'public' },
  { method: 'POST', pattern: '/api/v1/auth/logout', roles: 'public' },
  { method: 'POST', pattern: '/api/v1/integrations/:provider/webhook', roles: 'public' },
  // Setup: status is public (the web app decides whether to show /config);
  // everything else is admin, or the setup token while setup is pending.
  { method: 'GET', pattern: '/api/v1/setup/status', roles: 'public' },
  { method: 'GET', pattern: '/api/v1/setup/hardware', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/setup/agent-defaults', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/setup/models', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/models/pull', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/llm/test', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/setup/draft', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/setup/draft', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/setup/model-settings', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/setup/model-settings', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/restart', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/reset', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/add', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/remove', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/erase', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/setup/appearance-defaults', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/plan', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/apply', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/setup/config/effective', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/setup/secrets', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/setup/secrets/:name', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/setup/imports/retry', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/auth/me', roles: ANY },
  { method: 'GET', pattern: '/api/v1/me/preferences', roles: ANY },
  { method: 'PUT', pattern: '/api/v1/me/preferences', roles: ANY },
  { method: 'GET', pattern: '/api/v1/system/manifest', roles: ANY },
  { method: 'GET', pattern: '/api/v1/system/dashboard', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/system/base-memory/refresh', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/model-runtimes', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/usage', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/storage', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/events', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/jobs', roles: ANY },
  { method: 'GET', pattern: '/api/v1/system/jobs/stream', roles: ANY },
  { method: 'POST', pattern: '/api/v1/system/jobs/:id/cancel', roles: ANY },
  { method: 'GET', pattern: '/api/v1/system/modules', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/tools', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/mcp/card', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/mcp', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/controls', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/data-policy', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/data-processing', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/dashboard-settings', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/update', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/system/update/check', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/system/update/download', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/system/update/apply', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/system/dashboard-settings', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/connections', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/connections', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/connections/:id/test', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/connections/:id/secret', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/connections/:id/disable', roles: ADMIN },
  { method: 'DELETE', pattern: '/api/v1/connections/:id', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/system/data-policy', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/system/data-processing', roles: ADMIN },
  { method: 'PUT', pattern: '/api/v1/system/controls', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/approvals', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/approvals/:id/approve', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/approvals/:id/reject', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/skills', roles: ANY },
  { method: 'GET', pattern: '/api/v1/skills/sources', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/skills/export', roles: ANY },
  { method: 'POST', pattern: '/api/v1/skills', roles: ANY },
  { method: 'POST', pattern: '/api/v1/skills/import', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/skills/:name', roles: ANY },
  { method: 'PATCH', pattern: '/api/v1/skills/:id', roles: ANY },
  { method: 'DELETE', pattern: '/api/v1/skills/:id', roles: ANY },
  { method: 'POST', pattern: '/api/v1/skills/:id/suggestion', roles: ANY },
  { method: 'GET', pattern: '/api/v1/system/modules/health', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/system/modules/:id/uninstall', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/config', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/retention', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/system/retention/run', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/auth/users', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/auth/users', roles: ADMIN },
  { method: 'PATCH', pattern: '/api/v1/auth/users/:id/role', roles: ADMIN },

  { method: 'POST', pattern: '/api/v1/support/tickets', roles: ANY },
  { method: 'GET', pattern: '/api/v1/support/tickets/:id', roles: ANY },
  { method: 'POST', pattern: '/api/v1/support/tickets/:id/confirmation', roles: ANY },
  { method: 'GET', pattern: '/api/v1/support/tickets', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/support/queue', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/support/triage-policy', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/support/my-tickets', roles: ANY },
  { method: 'GET', pattern: '/api/v1/support/sla/breaches', roles: AGENT },
  { method: 'PATCH', pattern: '/api/v1/support/tickets/:id/assignment', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/support/tickets/:id/csat', roles: ANY },
  { method: 'GET', pattern: '/api/v1/support/canned-responses', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/support/canned-responses', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/support/tickets/:id/transitions', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/support/tickets/:id/resolve', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/support/tickets/:id/auto-reply', roles: AGENT },
  { method: 'PATCH', pattern: '/api/v1/support/tickets/:id/triage', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/support/auto-reply-policies', roles: AGENT },
  { method: 'PUT', pattern: '/api/v1/support/auto-reply-policies/:category', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/system/runs', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/runs/daily', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/runs/:id', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/runs/:id/graph', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/system/runs/:id/cancel', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/deadletters', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/system/deadletters/:id/replay', roles: ADMIN },
  { method: 'DELETE', pattern: '/api/v1/system/deadletters/:id', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/candidates', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/feedback-insights', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/candidates/export', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/system/candidates', roles: AGENT },
  { method: 'PATCH', pattern: '/api/v1/system/candidates/:id', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/audit', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/audit/verify', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/alerts', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/system/hw', roles: ADMIN },
  // Scrapers authenticate with METRICS_TOKEN instead (see auth guard).
  { method: 'GET', pattern: '/metrics', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/datasets', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/datasets/:id', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/datasets/:id/export', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/datasets', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/models', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/models/eval-reports', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/models', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/models/eval-reports', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/models/:id/promote', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/models/:id/rollback', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/kb/documents', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/kb/documents/:id', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/kb/search', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/kb/documents', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/kb/managed', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/kb/documents/:id/approve', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/kb/documents/:id/reingest', roles: ADMIN },
  { method: 'DELETE', pattern: '/api/v1/kb/documents/:id', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/kb/sources', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/kb/storage', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/kb/sources', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/kb/sources/batch', roles: ADMIN },
  { method: 'PATCH', pattern: '/api/v1/kb/sources/:id', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/kb/sources/:id/approve', roles: ADMIN },
  { method: 'DELETE', pattern: '/api/v1/kb/sources/:id', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/data-extract/datasets', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/data-extract/datasets/:id', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/data-extract/datasets/:id/rows', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/data-extract/datasets/:id/summary', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/data-extract/datasets', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/data-extract/datasets/:id/confirm', roles: ADMIN },
  { method: 'PATCH', pattern: '/api/v1/data-extract/datasets/:id', roles: AGENT },
  { method: 'DELETE', pattern: '/api/v1/data-extract/datasets/:id', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/data-extract/rules', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/integrations/:provider/actions', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/integrations/:provider/actions/:id/approve', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/integrations/:provider/actions/:id/reject', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/integrations/:provider/actions/:id/retry', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/chat/conversations', roles: ANY },
  { method: 'GET', pattern: '/api/v1/chat/conversations/:id', roles: ANY },
  { method: 'POST', pattern: '/api/v1/chat/conversations', roles: ANY },
  { method: 'POST', pattern: '/api/v1/chat/messages', roles: ANY },
  { method: 'POST', pattern: '/api/v1/chat/stream', roles: ANY },
  { method: 'PATCH', pattern: '/api/v1/chat/conversations/:id', roles: ANY },
  { method: 'DELETE', pattern: '/api/v1/chat/conversations/:id', roles: ANY },
  { method: 'POST', pattern: '/api/v1/chat/conversations/:id/restore', roles: ANY },
  { method: 'GET', pattern: '/api/v1/chat/conversations/:id/export', roles: ANY },
  { method: 'POST', pattern: '/api/v1/doc-assistant/ask', roles: ANY },
  { method: 'POST', pattern: '/api/v1/doc-assistant/reingest', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/echo/runs', roles: ANY },
  { method: 'POST', pattern: '/api/v1/echo/run', roles: ANY },
  { method: 'POST', pattern: '/api/v1/echo/note', roles: ANY },

  // Phase 13 public API: key management is admin; key-authenticated routes
  // are `public` at the session layer and validate the key in the module.
  { method: 'POST', pattern: '/api/v1/public-api/keys', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/public-api/keys', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/public-api/keys/:id/revoke', roles: ADMIN },
  { method: 'POST', pattern: '/v1/chat/completions', roles: 'key' },
  { method: 'POST', pattern: '/v1/embeddings', roles: 'key' },
  { method: 'POST', pattern: '/api/v1/public-api/kb/search', roles: 'key' },
  { method: 'POST', pattern: '/api/v1/public-api/external-agents', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/public-api/external-agents', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/public-api/external-agents/:id/handoffs', roles: ADMIN },
  { method: 'GET', pattern: '/v1/external-agents/handoffs', roles: 'key' },
  { method: 'POST', pattern: '/v1/external-agents/steps', roles: 'key' },
  { method: 'POST', pattern: '/v1/a2a/tasks', roles: 'key' },
  { method: 'GET', pattern: '/v1/a2a/tasks/:id', roles: 'key' },
  // Emailer: inbound is signed by the provider, the rest is agent/admin.
  { method: 'POST', pattern: '/api/v1/emailer/inbound', roles: 'public' },
  { method: 'GET', pattern: '/api/v1/emailer/threads', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/emailer/send', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/emailer/outbox', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/emailer/outbox/:id/approve', roles: ADMIN },

  // Phase 12 plugin administration (admin-only; the registry is supply-chain).
  { method: 'GET', pattern: '/api/v1/plugins', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/plugins/available', roles: ADMIN },
  { method: 'GET', pattern: '/api/v1/plugins/latest/:id', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/plugins/install', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/plugins/:id/enable', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/plugins/:id/disable', roles: ADMIN },
  { method: 'DELETE', pattern: '/api/v1/plugins/:id', roles: ADMIN },
  // Immutable web bundles are public JavaScript, like static assets.
  { method: 'GET', pattern: '/plugins/:id/:version/:file', roles: 'public' },
];

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[^/]+/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

/** The first matching rule, or undefined when only deny-by-default applies. */
export function explicitRuleFor(method: string, path: string): RouteRule | undefined {
  const upper = method.toUpperCase();
  return ROUTE_RULES.find(
    (rule) => rule.method === upper && patternToRegex(rule.pattern).test(path),
  );
}

export function ruleFor(method: string, path: string): RouteRule {
  const upper = method.toUpperCase();
  // CORS preflight carries no credentials by design.
  if (upper === 'OPTIONS') return { method: upper, pattern: path, roles: 'public' };
  return explicitRuleFor(upper, path) ?? { method: upper, pattern: path, roles: ADMIN };
}

export function isAllowed(role: Role, method: string, path: string): boolean {
  const rule = ruleFor(method, path);
  if (rule.roles === 'key') return false;
  return rule.roles === 'public' || rule.roles.includes(role);
}
