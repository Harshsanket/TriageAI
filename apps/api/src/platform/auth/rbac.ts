/**
 * Role-based access policy for the API surface (FR-11.1). Rules are ordered:
 * the first match wins. Anything unmatched is admin-only (deny by default).
 */
import type { Role } from './tokens.js';

export interface RouteRule {
  method: string;
  pattern: string;
  roles: Role[] | 'public';
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

  { method: 'GET', pattern: '/api/v1/auth/me', roles: ANY },
  { method: 'GET', pattern: '/api/v1/system/manifest', roles: ANY },
  { method: 'GET', pattern: '/api/v1/system/modules', roles: ADMIN },
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
  { method: 'POST', pattern: '/api/v1/support/tickets/:id/transitions', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/support/tickets/:id/resolve', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/support/tickets/:id/auto-reply', roles: AGENT },
  { method: 'PATCH', pattern: '/api/v1/support/tickets/:id/triage', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/support/auto-reply-policies', roles: AGENT },
  { method: 'PUT', pattern: '/api/v1/support/auto-reply-policies/:category', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/system/runs', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/runs/:id', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/system/runs/:id/cancel', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/candidates', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/candidates/export', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/system/candidates', roles: AGENT },
  { method: 'PATCH', pattern: '/api/v1/system/candidates/:id', roles: AGENT },
  { method: 'GET', pattern: '/api/v1/system/audit', roles: AGENT },
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
  { method: 'POST', pattern: '/api/v1/kb/documents/:id/approve', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/kb/documents/:id/reingest', roles: ADMIN },
  { method: 'DELETE', pattern: '/api/v1/kb/documents/:id', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/integrations/:provider/actions', roles: AGENT },
  { method: 'POST', pattern: '/api/v1/integrations/:provider/actions/:id/approve', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/integrations/:provider/actions/:id/reject', roles: ADMIN },
  { method: 'POST', pattern: '/api/v1/integrations/:provider/actions/:id/retry', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/chat/conversations', roles: ANY },
  { method: 'GET', pattern: '/api/v1/chat/conversations/:id', roles: ANY },
  { method: 'POST', pattern: '/api/v1/chat/conversations', roles: ANY },
  { method: 'POST', pattern: '/api/v1/chat/messages', roles: ANY },
  { method: 'POST', pattern: '/api/v1/doc-assistant/ask', roles: ANY },
  { method: 'POST', pattern: '/api/v1/doc-assistant/reingest', roles: ADMIN },

  { method: 'GET', pattern: '/api/v1/echo/runs', roles: ANY },
  { method: 'POST', pattern: '/api/v1/echo/run', roles: ANY },
  { method: 'POST', pattern: '/api/v1/echo/note', roles: ANY },
];

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[^/]+/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

export function ruleFor(method: string, path: string): RouteRule {
  const upper = method.toUpperCase();
  // CORS preflight carries no credentials by design.
  if (upper === 'OPTIONS') return { method: upper, pattern: path, roles: 'public' };
  for (const rule of ROUTE_RULES) {
    if (rule.method !== upper) continue;
    if (patternToRegex(rule.pattern).test(path)) return rule;
  }
  return { method: upper, pattern: path, roles: ADMIN };
}

export function isAllowed(role: Role, method: string, path: string): boolean {
  const rule = ruleFor(method, path);
  return rule.roles === 'public' || rule.roles.includes(role);
}
