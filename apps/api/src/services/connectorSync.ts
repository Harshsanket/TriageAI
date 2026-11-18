/**
 * 15.T7 connector sync: a host-owned scheduled workflow that runs a completed
 * read-only connector tool and mirrors its rows into a managed KB source.
 *
 * Sync lives on the host (not in a module) because the connection registry is a
 * host setting and the module boundary forbids a module writing another
 * module's tables.
 */
import { ulid } from 'ulid';

import type { Kernel, KernelLogger } from '@triageai/kernel';
import type { WorkflowDef } from '@triageai/kernel';

import { writeAudit } from './audit.js';
import { CONNECTOR_CONNECTIONS_KEY } from './connectors.js';
import type { ConnectorConnection } from './connectors.js';

const BODY_LIMIT = 20 * 1024;
const registered = new WeakSet<object>();

interface SyncOutcome {
  connectionId: string;
  tool: string;
  rows: number;
  stored: boolean;
  skipped?: string;
}

const syncLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function readConnections(kernel: Kernel): Promise<ConnectorConnection[]> {
  const rows = await kernel.database.query<{ value: ConnectorConnection[] }>(
    `SELECT value FROM settings WHERE key = $1`,
    [CONNECTOR_CONNECTIONS_KEY],
  );
  return Array.isArray(rows[0]?.value) ? (rows[0]?.value as ConnectorConnection[]) : [];
}

function renderBody(rows: unknown): string {
  let body = JSON.stringify(rows, null, 2);
  if (body.length <= BODY_LIMIT) return body;
  if (Array.isArray(rows)) {
    let kept = rows;
    while (kept.length > 0 && JSON.stringify(kept, null, 2).length > BODY_LIMIT) {
      kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
    }
    body = JSON.stringify(kept, null, 2);
    if (body.length <= BODY_LIMIT) return body;
  }
  return body.slice(0, BODY_LIMIT - 30) + '\n… [truncated for KB sync]';
}

function toolRows(data: unknown): unknown {
  if (data && typeof data === 'object' && 'rows' in data) {
    return (data as { rows: unknown }).rows;
  }
  return data;
}

async function upsertManagedSource(
  kernel: Kernel,
  connection: ConnectorConnection,
  rows: unknown,
): Promise<boolean> {
  if (!kernel.modules.includes('kb')) return false;
  const route = kernel
    .routes()
    .find((candidate) => candidate.method === 'POST' && candidate.url === '/api/v1/kb/managed');
  if (!route) return false;
  const sync = connection.sync;
  if (!sync) return false;
  await route.handler({
    method: 'POST',
    url: route.url,
    params: {},
    query: {},
    actor: 'system:connector-sync',
    body: {
      managedKey: `connector:${connection.id}:${sync.managedKey}`.slice(0, 120),
      title: sync.title,
      label: connection.name,
      body: renderBody(rows),
      audience: sync.audience ?? 'operator',
      sensitivity: sync.sensitivity ?? connection.defaultSensitivity,
      readOnly: true,
    },
  });
  return true;
}

async function writeWatermark(
  kernel: Kernel,
  connection: ConnectorConnection,
  outcome: Omit<SyncOutcome, 'connectionId'>,
): Promise<void> {
  await kernel.database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, 'system:connector-sync', now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [`connector.sync.${connection.id}`, { ...outcome, lastSyncAt: new Date().toISOString() }],
  );
}

/** Run one connection (admin test route) or every enabled sync target. */
export async function runConnectorSync(
  kernel: Kernel,
  connectionId?: string,
): Promise<{ synced: number; failed: number; outcomes: SyncOutcome[] }> {
  const connections = (await readConnections(kernel)).filter(
    (connection) => !connectionId || connection.id === connectionId,
  );
  const outcomes: SyncOutcome[] = [];
  let failed = 0;
  for (const connection of connections) {
    const sync = connection.sync;
    if (!sync?.enabled) continue;
    const tool = kernel.tools.get(sync.tool);
    if (!tool) {
      failed += 1;
      outcomes.push({
        connectionId: connection.id,
        tool: sync.tool,
        rows: 0,
        stored: false,
        skipped: 'tool_not_registered',
      });
      continue;
    }
    if (tool.access !== 'read') {
      failed += 1;
      outcomes.push({
        connectionId: connection.id,
        tool: sync.tool,
        rows: 0,
        stored: false,
        skipped: 'writes_are_not_synced',
      });
      continue;
    }
    const result = await kernel.tools.invoke(
      sync.tool,
      {},
      {
        runId: `connector-sync:${ulid()}`,
        stepId: 'connector.sync',
        actorId: 'system:connector-sync',
        grantedScopes: tool.scopes,
        egressClass: connection.defaultSensitivity,
        org: { ownsEmail: () => false },
        logger: syncLogger,
      },
      { approved: false },
    );
    if (!result.ok) {
      failed += 1;
      outcomes.push({
        connectionId: connection.id,
        tool: sync.tool,
        rows: 0,
        stored: false,
        skipped: result.error.code,
      });
      continue;
    }
    const rows = toolRows(result.data);
    const rowCount = Array.isArray(rows) ? rows.length : 1;
    const stored = await upsertManagedSource(kernel, connection, rows).catch(() => false);
    const outcome: SyncOutcome = {
      connectionId: connection.id,
      tool: sync.tool,
      rows: rowCount,
      stored,
    };
    outcomes.push(outcome);
    await writeWatermark(kernel, connection, outcome);
    await writeAudit(kernel.database, {
      actor: 'system:connector-sync',
      action: 'connector.synced',
      subject: connection.id,
      payload: { tool: sync.tool, rows: rowCount, stored },
    });
  }
  return { synced: outcomes.filter((entry) => !entry.skipped).length, failed, outcomes };
}

/**
 * Register the hourly sync workflow on a new engine generation. `silentWhenEmpty`
 * keeps an idle instance quiet; `overlap: skip` prevents a slow sync from
 * stacking runs.
 */
export function registerConnectorSync(kernel: Kernel): void {
  if (registered.has(kernel.workflowEngine)) return;
  registered.add(kernel.workflowEngine);
  kernel.workflowEngine.registerStageHandler('connector.sync', {
    execute: async () => {
      const result = await runConnectorSync(kernel);
      return {
        output: result,
        evidence: { connections: result.outcomes.length, failed: result.failed },
        deterministic: { workflow: 'connector.sync' },
      };
    },
  });
  const def: WorkflowDef = {
    id: 'connector.sync',
    version: '0.1.0',
    module: 'host',
    trigger: { type: 'schedule' },
    graph: {
      id: 'connector.sync',
      version: '0.1.0',
      module: 'host',
      trigger: {
        type: 'schedule',
        schedule: { cron: '0 * * * *', overlap: 'skip', silentWhenEmpty: true },
      },
      start: 'sync',
      nodes: [
        { id: 'sync', type: 'stage', kind: 'connector.sync' },
        { id: 'end', type: 'end', end: 'succeeded' },
        { id: 'failed', type: 'end', end: 'failed' },
      ],
      edges: [{ from: 'sync', to: 'end', label: 'next' }],
      defaultErrorEdge: { to: 'failed' },
      budget: { maxSteps: 5, maxDurationMs: 300_000 },
    },
    stages: [{ id: 'sync', kind: 'connector.sync' }],
  };
  kernel.workflowEngine.register(def, 'host', '0.1.0');
}
