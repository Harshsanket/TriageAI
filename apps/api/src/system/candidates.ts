/**
 * Feedback core (Phase 2): proposed corrections land in `candidate_examples`
 * with provenance. Approval/materialization is Phase 6.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';

import type { Kernel } from '@triageai/kernel';

const correctionSchema = z.object({
  runId: z.string().optional(),
  stageRunId: z.string().optional(),
  input: z.unknown(),
  gold: z.unknown(),
  reason: z.string().max(2000).optional(),
  actor: z.string().max(200).optional(),
});

interface CandidateRow {
  [key: string]: unknown;
  id: string;
  source: string;
  source_run_id: string | null;
  input: unknown;
  gold: unknown;
  provenance: Record<string, unknown>;
  status: string;
  created_at: Date | string;
}

const toCandidate = (row: CandidateRow) => ({
  id: row.id,
  source: row.source,
  sourceRunId: row.source_run_id,
  input: row.input,
  gold: row.gold,
  provenance: row.provenance,
  status: row.status,
  createdAt: new Date(row.created_at).toISOString(),
});

export function registerCandidateRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/candidates', async (request) => {
    const query = request.query as { status?: string; limit?: string };
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
    const rows = (await kernel.database.query(
      `SELECT id, source, source_run_id, input, gold, provenance, status, created_at
       FROM candidate_examples
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [query.status ?? null, limit],
    )) as unknown as CandidateRow[];
    return rows.map(toCandidate);
  });

  app.post('/api/v1/system/candidates', async (request, reply) => {
    const body = correctionSchema.parse(request.body);
    const id = ulid();
    const rows = (await kernel.database.query(
      `INSERT INTO candidate_examples (id, source, source_run_id, input, gold, provenance, status, actor)
       VALUES ($1, 'correction', $2, $3, $4, $5, 'proposed', $6)
       RETURNING id, source, source_run_id, input, gold, provenance, status, created_at`,
      [
        id,
        body.runId ?? null,
        body.input,
        body.gold,
        {
          stageRunId: body.stageRunId ?? null,
          reason: body.reason ?? null,
          submittedBy: body.actor ?? 'ui',
        },
        body.actor ?? null,
      ],
    )) as unknown as CandidateRow[];
    return reply.status(201).send(toCandidate(rows[0] as CandidateRow));
  });
}
