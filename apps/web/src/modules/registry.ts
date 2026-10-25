/** Module UI registry (ADR-0007 Phase-1 compromise: bundles live in the host
 * app, gating happens via the system manifest + this registry). */
import { lazy } from 'react';
import type { ComponentType } from 'react';

export const moduleRegistry: Record<string, ComponentType> = {
  echo: lazy(() => import('./echo/EchoApp')),
  chat: lazy(() => import('./chat/ChatApp')),
  support: lazy(() => import('./support/SupportApp')),
  kb: lazy(() => import('./kb/KbApp')),
  'doc-assistant': lazy(() => import('./doc-assistant/DocAssistantApp')),
  'integrations/github': lazy(() => import('./integrations/GitHubApp')),
  'integrations/slack': lazy(() => import('./integrations/SlackApp')),
};
