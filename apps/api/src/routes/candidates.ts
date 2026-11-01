/**
 * Feedback core + review queue (Phase 6).
 *
 * Corrections/confirmations land in `candidate_examples` as `proposed`; an
 * authorized reviewer approves or rejects them, which is the only path into a
 * dataset (FR-6.2/FR-6.3). Every review writes an `audit_events` row.
 */
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import {
  CandidateExportDtoSchema,
  FeedbackInsightsSchema,
  CandidateReviewRequestSchema,
  CorrectionRequestSchema,
} from '@triageai/contracts';
import type { Kernel } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';
import { candidateText } from '../services/candidates.js';
import { labelOf } from '../services/datasets.js';
import { AppError } from '../platform/errors.js';

interface CandidateRow {
  [key: string]: unknown;
  id: string;
  source: string;
  source_run_id: string | null;
  input: unknown;
  gold: unknown;
  provenance: Record<string, unknown>;
  status: string;
  actor: string | null;
  reviewed_at: Date | string | null;
  created_at: Date | string;
}

const toCandidate = (row: CandidateRow) => ({
  id: row.id,
  source: row.source,
  sourceRunId: row.source_run_id,
  input: row.input,
  gold: row.gold,
  provenance: row.provenance ?? {},
  status: row.status,
  actor: row.actor,
  reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
  createdAt: new Date(row.created_at).toISOString(),
});

export function registerCandidateRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/system/candidates/export', async (request) => {
    const query = request.query as { category?: string; status?: string; limit?: string };
    const status =
      query.status === 'proposed' || query.status === 'rejected' ? query.status : 'approved';
    const rawLimit = Number(query.limit ?? 500);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 5000) : 500;
    const rows = (await kernel.database.query<CandidateRow>(
      `SELECT id, source, source_run_id, input, gold, provenance, status, actor, reviewed_at, created_at
       FROM candidate_examples
       WHERE status = $1
         AND ($2::text IS NULL OR gold->>'category' = $2 OR gold->>'label' = $2)
       ORDER BY created_at ASC, id ASC
       LIMIT $3`,
      [status, query.category ?? null, limit],
    )) as unknown as CandidateRow[];
    return CandidateExportDtoSchema.parse({
      category: query.category ?? null,
      status,
      count: rows.length,
      examples: rows.map((row) => ({
        id: row.id,
        text: candidateText(row.input),
        expected: labelOf(row.gold),
        input: row.input,
        gold: row.gold,
        provenance: row.provenance ?? {},
      })),
    });
  });

  app.get('/api/v1/system/candidates', async (request) => {
    const query = request.query as { status?: string; source?: string; limit?: string };
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
    const rows = (await kernel.database.query<CandidateRow>(
      `SELECT id, source, source_run_id, input, gold, provenance, status, actor, reviewed_at, created_at
       FROM candidate_examples
       WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR source = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [query.status ?? null, query.source ?? null, limit],
    )) as unknown as CandidateRow[];
    return rows.map(toCandidate);
  });

  app.post('/api/v1/system/candidates', async (request, reply) => {
    const body = CorrectionRequestSchema.parse(request.body);
    const actor = request.principal?.email ?? body.actor ?? 'ui';
    const id = ulid();
    const rows = (await kernel.database.query<CandidateRow>(
      `INSERT INTO candidate_examples (id, source, source_run_id, input, gold, provenance, status, actor)
       VALUES ($1, 'correction', $2, $3, $4, $5, 'proposed', $6)
       RETURNING id, source, source_run_id, input, gold, provenance, status, actor, reviewed_at, created_at`,
      [
        id,
        body.runId ?? null,
        body.input,
        body.gold,
        {
          stageRunId: body.stageRunId ?? null,
          reason: body.reason ?? null,
          submittedBy: actor,
          method: body.method,
        },
        actor,
      ],
    )) as unknown as CandidateRow[];
    return reply.status(201).send(toCandidate(rows[0] as CandidateRow));
  });

  app.patch('/api/v1/system/candidates/:id', async (request) => {
    const { id } = request.params as { id: string };
    const parsedBody = CandidateReviewRequestSchema.parse(request.body);
    const body = { ...parsedBody, actor: request.principal?.email ?? parsedBody.actor };
    const updated = await kernel.database.transaction(async (tx) => {
      const rows = (await tx.query<CandidateRow>(
        `SELECT id, source, source_run_id, input, gold, provenance, status, actor, reviewed_at, created_at
         FROM candidate_examples WHERE id = $1 FOR UPDATE`,
        [id],
      )) as unknown as CandidateRow[];
      const current = rows[0];
      if (!current) throw new AppError('NOT_FOUND', `candidate ${id} not found`);
      if (current.status !== 'proposed') {
        throw new AppError(
          'CONFLICT',
          `candidate ${id} is already ${current.status}; reviewed examples are immutable`,
        );
      }
      const reviewedAt = new Date().toISOString();
      const merged = (await tx.query<CandidateRow>(
        `UPDATE candidate_examples
           SET status = $2, actor = $3, reviewed_at = $4, provenance = $5
         WHERE id = $1
         RETURNING id, source, source_run_id, input, gold, provenance, status, actor, reviewed_at, created_at`,
        [
          id,
          body.status,
          body.actor,
          reviewedAt,
          {
            ...(current.provenance ?? {}),
            review: {
              decision: body.status,
              actor: body.actor,
              method: body.method ?? 'mistake',
              note: body.note ?? null,
              reviewedAt,
            },
          },
        ],
      )) as unknown as CandidateRow[];
      return merged[0] as CandidateRow;
    });
    await writeAudit(kernel.database, {
      actor: body.actor,
      action: 'feedback.reviewed',
      subject: id,
      payload: {
        decision: body.status,
        method: body.method ?? 'mistake',
        note: body.note ?? null,
        source: updated.source,
      },
    });
    return toCandidate(updated);
  });
  app.get('/api/v1/system/feedback-insights', async (request) => {
    const query = request.query as { source?: string; status?: string; limit?: string };
    const limit = Math.min(Math.max(1, Number(query.limit ?? 100)), 500);
    const [candidates, datasets, evals] = await Promise.all([
      kernel.database.query<CandidateRow>(
        `SELECT id, source, source_run_id, input, gold, provenance, status, actor, reviewed_at, created_at
           FROM candidate_examples
          WHERE ($1::text IS NULL OR source = $1)
            AND ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC LIMIT $3`,
        [query.source ?? null, query.status ?? null, limit],
      ),
      kernel.database
        .query<{ id: string; version: string; created_at: Date | string }>(
          `SELECT id, version::text, created_at FROM datasets ORDER BY created_at DESC LIMIT 1`,
        )
        .catch(() => []),
      kernel.database
        .query<{ id: string; created_at: Date | string }>(
          `SELECT id, created_at FROM eval_reports ORDER BY created_at DESC LIMIT 1`,
        )
        .catch(() => []),
    ]);
    const dataset = datasets[0];
    const evaluation = evals[0];
    const items = candidates.map((row) => {
      const provenance = row.provenance ?? {};
      const rating =
        provenance.rating === 'positive' || provenance.rating === 'negative'
          ? (provenance.rating as 'positive' | 'negative')
          : row.status === 'approved'
            ? 'positive'
            : row.status === 'rejected'
              ? 'negative'
              : 'neutral';
      return {
        id: row.id,
        source: row.source,
        status: row.status,
        rating,
        reason: typeof provenance.reason === 'string' ? provenance.reason : null,
        text: candidateText(row.input),
        answer: typeof provenance.answer === 'string' ? provenance.answer : null,
        citations: Array.isArray(provenance.citations)
          ? provenance.citations.filter((entry): entry is string => typeof entry === 'string')
          : [],
        module: typeof provenance.module === 'string' ? provenance.module : null,
        agent: typeof provenance.agent === 'string' ? provenance.agent : null,
        conversationId:
          typeof provenance.conversationId === 'string' ? provenance.conversationId : null,
        ticketId: typeof provenance.ticketId === 'string' ? provenance.ticketId : null,
        model: typeof provenance.model === 'string' ? provenance.model : null,
        promptVersion:
          typeof provenance.promptVersion === 'string' ? provenance.promptVersion : null,
        createdAt: new Date(row.created_at).toISOString(),
        timeline: [
          {
            step: 'received' as const,
            at: new Date(row.created_at).toISOString(),
            detail: row.source,
            href: null,
            status: 'done' as const,
          },
          {
            step: 'triaged' as const,
            at: new Date(row.created_at).toISOString(),
            detail: 'candidate created',
            href: null,
            status: 'done' as const,
          },
          {
            step: 'reviewed' as const,
            at: row.reviewed_at
              ? new Date(row.reviewed_at).toISOString()
              : new Date(row.created_at).toISOString(),
            detail: row.status,
            href: null,
            status: row.status === 'proposed' ? ('pending' as const) : ('done' as const),
          },
          {
            step: 'added_to_dataset' as const,
            at: dataset
              ? new Date(dataset.created_at).toISOString()
              : new Date(row.created_at).toISOString(),
            detail: dataset ? `dataset v${dataset.version}` : 'not added yet',
            href: dataset ? `/datasets/${dataset.id}/export` : null,
            status: row.status === 'approved' ? ('done' as const) : ('pending' as const),
          },
          {
            step: 'used_in_eval' as const,
            at: evaluation
              ? new Date(evaluation.created_at).toISOString()
              : new Date(row.created_at).toISOString(),
            detail: evaluation ? `eval ${evaluation.id}` : 'not evaluated yet',
            href: evaluation ? '/feedback' : null,
            status:
              row.status === 'approved' && evaluation ? ('done' as const) : ('pending' as const),
          },
          {
            step: 'outcome' as const,
            at: row.reviewed_at
              ? new Date(row.reviewed_at).toISOString()
              : new Date(row.created_at).toISOString(),
            detail: row.status,
            href: null,
            status:
              row.status === 'rejected'
                ? ('rejected' as const)
                : row.status === 'approved'
                  ? ('done' as const)
                  : ('pending' as const),
          },
        ],
      };
    });
    const volume = new Map<string, Record<string, number>>();
    const sentiment = new Map<string, { positive: number; negative: number }>();
    const reasons = new Map<string, number>();
    let reviewHours = 0;
    let reviewed = 0;
    for (const item of items) {
      const bucket = item.createdAt.slice(0, 10);
      const point = volume.get(bucket) ?? {};
      point[item.source] = (point[item.source] ?? 0) + 1;
      volume.set(bucket, point);
      const rate = sentiment.get(bucket) ?? { positive: 0, negative: 0 };
      if (item.rating === 'positive') rate.positive += 1;
      if (item.rating === 'negative') rate.negative += 1;
      sentiment.set(bucket, rate);
      if (item.reason) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
      if (item.status !== 'proposed') {
        reviewed += 1;
        const row = candidates.find((candidate) => candidate.id === item.id);
        if (row?.reviewed_at) {
          reviewHours +=
            (new Date(row.reviewed_at).getTime() - new Date(row.created_at).getTime()) / 3_600_000;
        }
      }
    }
    return FeedbackInsightsSchema.parse({
      items,
      graphs: {
        volume: [...volume.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([bucket, bySource]) => ({ bucket, bySource })),
        sentiment: [...sentiment.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([bucket, values]) => ({ bucket, ...values })),
        topReasons: [...reasons.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([reason, count]) => ({ reason, count })),
        funnel: {
          received: items.length,
          reviewed,
          accepted: items.filter((item) => item.status === 'approved').length,
          used:
            dataset && evaluation ? items.filter((item) => item.status === 'approved').length : 0,
        },
        avgReviewHours: reviewed === 0 ? null : Number((reviewHours / reviewed).toFixed(2)),
      },
    });
  });
}
