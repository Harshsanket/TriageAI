/**
 * Read-only operational tools (ADR-0057): `system.get_status`,
 * `system.get_uptime` and `system.get_storage` expose the same facts as
 * `/dashboard` through the mandatory tool contract. Every call is audited and
 * operator-only (scopes: system.read).
 */
import { z } from 'zod';

import type { Kernel } from '@triageai/kernel';

import { readSystemStatus, type ConnectedApiFact } from './dashboardReads.js';
import { writeAudit } from './audit.js';

const InputSchema = z.object({}).strict();
const OutputSchema = z.record(z.string(), z.unknown());

const TOOL_BASE = {
  version: '1.0.0',
  owner: 'system',
  examples: [{}],
  input: InputSchema,
  output: OutputSchema,
  access: 'read' as const,
  risk: 'low' as const,
  scopes: ['system.read'],
  egressClass: 'internal' as const,
  idempotent: true,
  timeoutMs: 5_000,
  undo: 'free' as const,
  retry: { maxAttempts: 1, backoff: 'none' as const, retryOn: [] },
};

export function registerSystemTools(
  kernel: Kernel,
  reads: {
    status(connectedApis: ConnectedApiFact[]): Promise<Record<string, unknown>>;
    connections(): Promise<ConnectedApiFact[]>;
  },
): void {
  const audit = async (tool: string, actor: string | undefined, runId: string) => {
    await writeAudit(kernel.database, {
      actor: actor ?? 'system',
      action: `tool.${tool}`,
      subject: runId,
      payload: { tool },
    }).catch(() => undefined);
  };

  kernel.tools.register({
    ...TOOL_BASE,
    name: 'system.get_status',
    description:
      'Read the current system status: health, queue, activity, storage, cost, uptime and connected APIs.',
    scopes: ['system.read'],
    handler: async (_input, ctx) => {
      const connected = await reads.connections();
      const snapshot = await reads.status(connected);
      await audit('system.get_status', ctx.actorId, ctx.runId);
      return snapshot;
    },
  });

  kernel.tools.register({
    ...TOOL_BASE,
    name: 'system.get_uptime',
    description:
      'Read system and service uptime percentages from the last 24 hours, with the current status.',
    handler: async (_input, ctx) => {
      const snapshot = await reads.status(await reads.connections());
      await audit('system.get_uptime', ctx.actorId, ctx.runId);
      return {
        asOf: snapshot.asOf,
        ...(snapshot.uptime as Record<string, unknown>),
      };
    },
  });

  kernel.tools.register({
    ...TOOL_BASE,
    name: 'system.get_storage',
    description:
      'Read storage usage by category (database tables, blobs, models, plugins, logs) and the total.',
    handler: async (_input, ctx) => {
      const snapshot = await reads.status(await reads.connections());
      await audit('system.get_storage', ctx.actorId, ctx.runId);
      return { asOf: snapshot.asOf, ...(snapshot.storage as Record<string, unknown> | null) };
    },
  });
}

export function systemReads(
  kernel: () => Kernel | undefined,
  connections: () => Promise<ConnectedApiFact[]>,
) {
  return {
    async status(connectedApis: ConnectedApiFact[]) {
      const current = kernel();
      if (!current) throw new Error('kernel is not ready');
      return readSystemStatus(current, { connectedApis }) as unknown as Promise<
        Record<string, unknown>
      >;
    },
    connections,
  };
}
