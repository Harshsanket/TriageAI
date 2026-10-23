/**
 * hw-monitor v1: host/runtime resource snapshot (the container exposes no
 * docker socket; node os metrics + queue backlog are the Phase-2 signal).
 */
import os from 'node:os';
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

export function registerHardwareRoute(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/hw', async () => {
    const memory = process.memoryUsage();
    const backlog = (await kernel.database.query(
      `SELECT status, COUNT(*)::int AS count FROM queue_jobs
       WHERE status IN ('pending','processing') GROUP BY status`,
    )) as Array<{ status: string; count: number }>;
    const queue = Object.fromEntries(backlog.map((row) => [row.status, row.count]));

    return {
      capturedAt: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg().map((value) => Number(value.toFixed(2))),
      memoryTotalBytes: os.totalmem(),
      memoryFreeBytes: os.freemem(),
      processRssBytes: memory.rss,
      processHeapUsedBytes: memory.heapUsed,
      queuePending: queue.pending ?? 0,
      queueProcessing: queue.processing ?? 0,
    };
  });
}
