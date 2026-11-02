/** Live dashboard/agent events over SSE (Phase 18.T13) with LISTEN/NOTIFY. */
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
        const send = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        let timer: NodeJS.Timeout | undefined;
        let unsubscribe: (() => Promise<void>) | undefined;
        let closed = false;
        let running = false;
        const close = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          void unsubscribe?.();
          try {
            controller.close();
          } catch {
            // client already gone
          }
        };
        request.raw.on('close', close);
        send('hello', { at: new Date().toISOString() });
        const tick = async () => {
          if (running || closed) return;
          running = true;
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
          } finally {
            running = false;
          }
          if (once) close();
        };
        void tick();
        if (!once) {
          void kernel.database
            .listen?.('triageai_events', () => void tick())
            .then((off) => {
              unsubscribe = off;
              if (closed) void off();
            })
            .catch(() => undefined);
          // Fallback poll: notifications are an optimisation, not a guarantee.
          timer = setInterval(() => void tick(), 15_000);
        }
      },
    });
    return reply.send(stream);
  });
}
