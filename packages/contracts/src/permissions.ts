/**
 * Module permission manifest (ADR-0054 §2). Anything absent is denied; the
 * kernel enforces every entry on every call. Roles default to admin when a
 * route omits them (the host may still apply its RBAC matrix).
 */
import { z } from 'zod';

export const ModuleRoleSchema = z.enum(['customer', 'agent', 'admin']);
export type ModuleRole = z.infer<typeof ModuleRoleSchema>;

export const ModuleRouteGrantSchema = z
  .object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
    path: z.string().startsWith('/'),
    roles: z.union([z.array(ModuleRoleSchema), z.literal('public'), z.literal('key')]).optional(),
  })
  .strict();
export type ModuleRouteGrant = z.infer<typeof ModuleRouteGrantSchema>;

export const ModulePermissionsSchema = z
  .object({
    storage: z
      .object({ schema: z.literal(true), maxBytes: z.number().int().positive().optional() })
      .strict()
      .optional(),
    routes: z.array(ModuleRouteGrantSchema).default([]),
    events: z
      .object({
        /**
         * Event-name prefix this module may publish under. Defaults to the
         * module id. Modules whose logical namespace differs from the id
         * (e.g. `emailer` → `email.*`) must declare it explicitly.
         */
        namespace: z
          .string()
          .regex(/^[a-z][a-z0-9_-]*$/)
          .optional(),
        publish: z.array(z.string()).default([]),
        subscribe: z.array(z.string()).default([]),
      })
      .strict()
      .default({ publish: [], subscribe: [] }),
    capabilities: z
      .object({
        consume: z.array(z.string()).default([]),
        provide: z.array(z.string()).default([]),
      })
      .strict()
      .default({ consume: [], provide: [] }),
    stages: z.array(z.string()).default([]),
    workflows: z.array(z.string()).default([]),
    evals: z.array(z.string()).default([]),
    tools: z.array(z.string()).default([]),
    egress: z
      .object({
        hosts: z.array(z.string()).default([]),
        dataClasses: z.array(z.enum(['public', 'internal', 'restricted', 'secret'])).default([]),
      })
      .strict()
      .optional(),
    knowledge: z
      .object({
        read: z.array(z.string()).default([]),
        write: z.array(z.string()).default([]),
      })
      .strict()
      .default({ read: [], write: [] }),
  })
  .strict();

export type ModulePermissions = z.infer<typeof ModulePermissionsSchema>;

export const PermissionDiffSchema = z.object({
  moduleId: z.string(),
  fromVersion: z.string().nullable(),
  toVersion: z.string(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
});
export type PermissionDiff = z.infer<typeof PermissionDiffSchema>;
