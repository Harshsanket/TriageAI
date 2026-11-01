/** Module UI registry (ADR-0007 Phase-1 compromise: bundles live in the host
 * app, gating happens via the system manifest + this registry). */
import { lazy } from 'react';
import type { ComponentType } from 'react';

export const moduleRegistry: Record<string, ComponentType> = {
  echo: lazy(() => import('./echo/EchoApp')),
  chat: lazy(() => import('./chat/ChatApp')),
  support: lazy(() => import('./support/SupportApp')),
  kb: lazy(() => import('./kb/KbApp')),
  'data-extract': lazy(() => import('./data-extract/DataExtractApp')),
  'doc-assistant': lazy(() => import('./doc-assistant/DocAssistantApp')),
  'integrations/github': lazy(() => import('./integrations/GitHubApp')),
  'integrations/slack': lazy(() => import('./integrations/SlackApp')),
};

const bundleCache = new Map<string, ComponentType>();

/**
 * Phase 12 (ADR-0027): a module manifest may carry `bundleUrl`. The host loads
 * that ESM bundle from the plugin volume; first-party in-host bundles keep
 * using the static registry until migrated.
 */
export function moduleComponent(
  path: string,
  bundleUrl: string | undefined,
): ComponentType | undefined {
  if (!bundleUrl) return moduleRegistry[path.replace('/', '')];
  const cached = bundleCache.get(bundleUrl);
  if (cached) return cached;
  const component = lazy(async () => {
    const imported = (await import(/* @vite-ignore */ bundleUrl)) as {
      default?: ComponentType;
      Component?: ComponentType;
    };
    const resolved = imported.default ?? imported.Component;
    if (!resolved) throw new Error(`plugin bundle ${bundleUrl} has no default export`);
    return { default: resolved };
  });
  bundleCache.set(bundleUrl, component);
  return component;
}
