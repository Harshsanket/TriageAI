/**
 * Generic long-running job surface (Phase 20.1): durable state from
 * `job_progress`, scoped by owner for customers. The stream is poll-backed so
 * it survives multiple API instances without extra infrastructure (18.7).
 */
import type { FastifyInstance } from 'fastify';

import type { JobDto, JobsResponse } from '@triageai/contracts';
import { JobDtoSchema, JobsResponseSchema } from '@triageai/contracts';
import type { Database, Kernel } from '@triageai/kernel';
import { AppError } from '@triageai/kernel';

interface JobRow {
  [key: string]: unknown;
  job_id: string;
  run_id: string | null;
  workflow_id: string | null;
  owner_id: string | null;
  title: string;
  stage: string | null;
  done: number;
  total: number;
  unit: string;
  status: string;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const ACTIVE = ['running', 'awaiting'];

const toDto = (row: JobRow): JobDto =>
  JobDtoSchema.parse({
    id: row.job_id,
    runId: row.run_id,
    workflowId: row.workflow_id,
    title: row.title,
    stage: row.stage ?? null,
    done: Number(row.done ?? 0),
    total: Number(row.total ?? 0),
    unit: row.unit ?? 'items',
    status: row.status,
    error: row.error ?? null,
    ownerId: row.owner_id ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });

async function readJobs(database: Database, ownerId: string | null): Promise<JobsResponse> {
  const params: unknown[] = [];
  const ownerClause = ownerId === null ? '' : `AND owner_id = $${params.push(ownerId)}`;
  const rows = await database.query<JobRow>(
    `SELECT job_id, run_id, workflow_id, owner_id, title, stage, done, total, unit, status,
            error, created_at, updated_at
       FROM job_progress
      WHERE 1 = 1 ${ownerClause}
      ORDER BY updated_at DESC
      LIMIT 60`,
    params,
  );
  const active = rows
    .filter((row) => ACTIVE.includes(row.status))
    .slice(0, 20)
    .map(toDto);
  const recent = rows
    .filter((row) => !ACTIVE.includes(row.status))
    .slice(0, 20)
    .map(toDto);
  return JobsResponseSchema.parse({ active, recent });
}

export function registerJobRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/jobs', async (request) => {
    const ownerId =
      request.principal?.role === 'customer' ? (request.principal.userId ?? null) : null;
    return readJobs(kernel.database, ownerId);
  });

  app.get('/api/v1/system/jobs/stream', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const once = query.once === '1' || query.once === 'true';
    const ownerId =
      request.principal?.role === 'customer' ? (request.principal.userId ?? null) : null;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          try {
            controller.close();
          } catch {
            // client already gone
          }
        };
        const send = (event: string, payload: unknown): void => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          );
        };
        const tick = async (): Promise<void> => {
          try {
            send('jobs', await readJobs(kernel.database, ownerId));
          } catch (err) {
            send('error', { message: (err as Error).message });
          }
          if (once) close();
          else timer = setTimeout(() => void tick(), 1500);
        };
        request.raw.on('close', close);
        await tick();
      },
    });
    reply.header('cache-control', 'no-cache');
    reply.header('x-accel-buffering', 'no');
    reply.type('text/event-stream');
    return reply.send(stream);
  });

  app.post('/api/v1/system/jobs/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const rows = await kernel.database.query<JobRow>(
      `SELECT job_id, run_id, owner_id, status FROM job_progress WHERE job_id = $1`,
      [id],
    );
    const job = rows[0];
    if (!job) throw new AppError('NOT_FOUND', 'job not found');
    const isAdmin = request.principal?.role === 'admin';
    if (!isAdmin && job.owner_id !== (request.principal?.userId ?? null)) {
      throw new AppError('NOT_FOUND', 'job not found');
    }
    if (!ACTIVE.includes(job.status)) {
      throw new AppError('CONFLICT', 'job is already finished');
    }
    const cancelled = job.run_id ? await kernel.workflowEngine.cancel(job.run_id) : false;
    if (!cancelled) {
      await kernel.database.query(
        `UPDATE job_progress SET status = 'cancelled', updated_at = now() WHERE job_id = $1`,
        [id],
      );
    }
    return { cancelled: true, jobId: id };
  });
}
