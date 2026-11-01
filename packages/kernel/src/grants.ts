/**
 * Permission-grant enforcement (ADR-0054 §2). Modules get nothing they did not
 * declare; every denial is a `kernel.POLICY_BLOCKED` and is audited by the
 * caller (the kernel context wires that up).
 */
import { createHash } from 'node:crypto';

import {
  ModulePermissionsSchema,
  PermissionDiffSchema,
  type ModulePermissions,
  type PermissionDiff,
} from '@triageai/contracts';

import { AppError } from './errors.js';
import type { Database, ModuleRunMode, TriageModule } from './types.js';

export type GrantResource =
  | 'route'
  | 'event.publish'
  | 'event.subscribe'
  | 'capability.consume'
  | 'capability.provide'
  | 'stage'
  | 'workflow'
  | 'tool'
  | 'egress'
  | 'knowledge.read'
  | 'knowledge.write';

export function grantDenied(moduleId: string, resource: GrantResource, name: string): AppError {
  return new AppError(
    'kernel.POLICY_BLOCKED',
    `module "${moduleId}" is not granted ${resource} "${name}"`,
    { moduleId, resource, name },
    403,
    { category: 'policy_blocked', retryable: false },
  );
}

/** Stable, order-independent representation used for hashing and diffs. */
export function normalizePermissions(input: unknown): ModulePermissions {
  const parsed = ModulePermissionsSchema.parse(input ?? {});
  const sorted = <T>(values: T[]): T[] => [...values].sort();
  return {
    ...parsed,
    routes: [...parsed.routes].sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    ),
    events: {
      ...(parsed.events.namespace ? { namespace: parsed.events.namespace } : {}),
      publish: sorted(parsed.events.publish),
      subscribe: sorted(parsed.events.subscribe),
    },
    capabilities: {
      consume: sorted(parsed.capabilities.consume),
      provide: sorted(parsed.capabilities.provide),
    },
    stages: sorted(parsed.stages),
    workflows: sorted(parsed.workflows),
    evals: sorted(parsed.evals),
    tools: sorted(parsed.tools),
    knowledge: { read: sorted(parsed.knowledge.read), write: sorted(parsed.knowledge.write) },
    ...(parsed.egress
      ? {
          egress: {
            hosts: sorted(parsed.egress.hosts),
            dataClasses: sorted(parsed.egress.dataClasses),
          },
        }
      : {}),
  };
}

export function permissionHash(permissions: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizePermissions(permissions)))
    .digest('hex');
}

function permissionKeys(permissions: ModulePermissions): Set<string> {
  const keys = new Set<string>();
  if (permissions.storage) keys.add('storage:schema');
  for (const route of permissions.routes) keys.add(`route:${route.method} ${route.path}`);
  if (permissions.events.namespace) keys.add(`event.namespace:${permissions.events.namespace}`);
  for (const event of permissions.events.publish) keys.add(`event.publish:${event}`);
  for (const event of permissions.events.subscribe) keys.add(`event.subscribe:${event}`);
  for (const capability of permissions.capabilities.consume)
    keys.add(`capability.consume:${capability}`);
  for (const capability of permissions.capabilities.provide)
    keys.add(`capability.provide:${capability}`);
  for (const stage of permissions.stages) keys.add(`stage:${stage}`);
  for (const workflow of permissions.workflows) keys.add(`workflow:${workflow}`);
  for (const suite of permissions.evals) keys.add(`eval:${suite}`);
  for (const tool of permissions.tools) keys.add(`tool:${tool}`);
  for (const host of permissions.egress?.hosts ?? []) keys.add(`egress:${host}`);
  for (const collection of permissions.knowledge.read) keys.add(`knowledge.read:${collection}`);
  for (const collection of permissions.knowledge.write) keys.add(`knowledge.write:${collection}`);
  return keys;
}

export function diffPermissions(
  moduleId: string,
  fromVersion: string | null,
  toVersion: string,
  before: ModulePermissions | null,
  after: ModulePermissions,
): PermissionDiff {
  const left = before ? permissionKeys(normalizePermissions(before)) : new Set<string>();
  const right = permissionKeys(normalizePermissions(after));
  return PermissionDiffSchema.parse({
    moduleId,
    fromVersion,
    toVersion,
    added: [...right].filter((key) => !left.has(key)).sort(),
    removed: [...left].filter((key) => !right.has(key)).sort(),
  });
}

export function permissionsWiden(
  before: ModulePermissions | null,
  after: ModulePermissions,
): boolean {
  return diffPermissions('', null, '', before, after).added.length > 0;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function allows(grants: string[], value: string): boolean {
  return grants.some(
    (grant) => grant === value || (grant.includes('*') && globToRegex(grant).test(value)),
  );
}

export interface DenialHook {
  (resource: GrantResource, name: string): void;
}

export class GrantsEngine {
  readonly permissions: ModulePermissions;

  constructor(
    readonly moduleId: string,
    permissions: unknown,
    private readonly onDenied?: DenialHook,
    /**
     * First-party in-process modules without an explicit manifest keep the
     * pre-22A behaviour: the process is the trust boundary. Third-party
     * modules always default-deny.
     */
    private readonly allowAll = false,
  ) {
    this.permissions = normalizePermissions(permissions);
  }

  private deny(resource: GrantResource, name: string): never {
    this.onDenied?.(resource, name);
    throw grantDenied(this.moduleId, resource, name);
  }

  private granted(): boolean {
    return this.allowAll;
  }

  assertRoute(method: string, path: string): void {
    if (this.granted()) return;
    const granted = this.permissions.routes.some(
      (route) => route.method === method.toUpperCase() && route.path === path,
    );
    if (!granted) this.deny('route', `${method.toUpperCase()} ${path}`);
  }

  get eventNamespace(): string {
    return this.permissions.events.namespace ?? this.moduleId;
  }

  assertEventPublish(event: string): void {
    if (this.granted()) return;
    if (!event.startsWith(`${this.eventNamespace}.`)) {
      this.deny('event.publish', `${event} (namespace is ${this.eventNamespace}.*)`);
    }
    if (!this.permissions.events.publish.includes(event)) this.deny('event.publish', event);
  }

  assertEventSubscribe(event: string): void {
    if (this.granted()) return;
    if (!this.permissions.events.subscribe.includes(event)) this.deny('event.subscribe', event);
  }

  assertCapabilityConsume(id: string): void {
    if (this.granted()) return;
    if (!this.permissions.capabilities.consume.includes(id)) {
      this.deny('capability.consume', id);
    }
  }

  assertCapabilityProvide(id: string): void {
    if (this.granted()) return;
    if (!this.permissions.capabilities.provide.includes(id)) {
      this.deny('capability.provide', id);
    }
  }

  assertStage(kind: string): void {
    if (this.granted()) return;
    if (!this.permissions.stages.includes(kind)) this.deny('stage', kind);
  }

  assertWorkflow(id: string): void {
    if (this.granted()) return;
    if (!this.permissions.workflows.includes(id)) this.deny('workflow', id);
  }

  assertTool(name: string): void {
    if (this.granted()) return;
    if (!this.permissions.tools.includes(name)) this.deny('tool', name);
  }

  assertEgress(url: string, dataClass?: string): void {
    if (this.granted()) return;
    const host = new URL(url).hostname;
    const egress = this.permissions.egress;
    if (!egress || !allows(egress.hosts, host)) this.deny('egress', host);
    if (dataClass && !egress.dataClasses.includes(dataClass as never)) {
      this.deny('egress', `${host} (${dataClass})`);
    }
  }

  assertKnowledge(collection: string, mode: 'read' | 'write'): void {
    if (this.granted()) return;
    const granted =
      mode === 'read' ? this.permissions.knowledge.read : this.permissions.knowledge.write;
    if (!allows(granted, collection)) this.deny(`knowledge.${mode}`, collection);
  }
}

export interface ModuleGrantRow {
  moduleId: string;
  version: string;
  manifestHash: string;
  permissions: ModulePermissions;
  runMode: ModuleRunMode;
  approvedBy: string | null;
  approvedAt: string;
}

/** Persisted, audited approvals (one row per module; upgrade replaces it). */
export class GrantStore {
  constructor(private readonly database: Database) {}

  async get(moduleId: string): Promise<ModuleGrantRow | null> {
    const rows = await this.database.query<{
      module_id: string;
      version: string;
      manifest_hash: string;
      permissions: ModulePermissions;
      run_mode: string;
      approved_by: string | null;
      approved_at: Date | string;
    }>(
      `SELECT module_id, version, manifest_hash, permissions, run_mode, approved_by, approved_at
         FROM module_grants WHERE module_id = $1`,
      [moduleId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      moduleId: row.module_id,
      version: row.version,
      manifestHash: row.manifest_hash,
      permissions: normalizePermissions(row.permissions),
      runMode: (row.run_mode as ModuleRunMode) ?? 'in-process',
      approvedBy: row.approved_by,
      approvedAt: new Date(row.approved_at).toISOString(),
    };
  }

  async approve(
    module: Pick<TriageModule, 'id' | 'version' | 'permissions' | 'runMode'>,
    actor: string | null,
  ): Promise<ModuleGrantRow> {
    const hash = permissionHash(module.permissions ?? {});
    const permissions = normalizePermissions(module.permissions ?? {});
    const runMode = module.runMode ?? 'in-process';
    await this.database.query(
      `INSERT INTO module_grants
         (module_id, version, manifest_hash, permissions, run_mode, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (module_id) DO UPDATE
         SET version = EXCLUDED.version,
             manifest_hash = EXCLUDED.manifest_hash,
             permissions = EXCLUDED.permissions,
             run_mode = EXCLUDED.run_mode,
             approved_by = EXCLUDED.approved_by,
             approved_at = now()`,
      [module.id, module.version, hash, permissions, runMode, actor],
    );
    return {
      moduleId: module.id,
      version: module.version,
      manifestHash: hash,
      permissions,
      runMode,
      approvedBy: actor,
      approvedAt: new Date().toISOString(),
    };
  }
}

/** Parse a module's manifest once, with a clear boot error on malformed input. */
export function parseModulePermissions(module: TriageModule): ModulePermissions {
  return normalizePermissions(module.permissions ?? {});
}
