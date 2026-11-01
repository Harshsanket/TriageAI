/** Live dashboard/agent events over SSE (Phase 18.T13 v1: poll-backed). */
import type { FastifyInstance } from 'fastify';

import type { Kernel } from '@triageai/kernel';

export function registerEventRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/events', async (request, reply) => {
    const once = (request.query as Record<string, string>).once === '1';
    reply.header('content-type', 'text/event-stream');
    reply.header('cache-control', 'no-cache');
    reply.header('x-accel-buffering', 'no');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: unknown) =>
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        let timer: NodeJS.Timeout | undefined;
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          controller.close();
        };
        request.raw.on('close', close);
        send('hello', { at: new Date().toISOString() });
        const tick = async () => {
          try {
            const rows = await kernel.database.query<{ active: number; last_hour: number }>(
              `SELECT COUNT(*) FILTER (WHERE status IN ('PENDING','RUNNING','AWAITING'))::int AS active,
                      COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS last_hour
               FROM workflow_runs`,
            );
            send('activity', {
              at: new Date().toISOString(),
              activeRuns: rows[0]?.active ?? 0,
              runsLastHour: rows[0]?.last_hour ?? 0,
            });
          } catch {
            send('error', { userMessage: 'live updates are temporarily unavailable' });
          }
          if (once) close();
        };
        void tick();
        if (!once) timer = setInterval(() => void tick(), 2_000);
      },
    });
    return reply.send(stream);
  });
}
