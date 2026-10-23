/** Module UI registry (ADR-0007 Phase-1 compromise: bundles live in the host
 * app, gating happens via the system manifest + this registry). */
import { lazy } from 'react';
import type { ComponentType } from 'react';

export const moduleRegistry: Record<string, ComponentType> = {
  echo: lazy(() => import('./echo/EchoApp')),
  chat: lazy(() => import('./chat/ChatApp')),
};
