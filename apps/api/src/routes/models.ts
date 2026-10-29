/**
 * Model registry + eval report ingestion (Phase 6).
 *
 * Promotion requires a passing report and cannot regress the active baseline.
 * Rollback restores a previously active asset; both actions are audited and
 * invalidate the runtime registry cache so the next run records the new pointer.
 */
import type { FastifyInstance } from 'fastify';
import { ulid } from 'ulid';

import {
  EvalReportInputSchema,
  PromoteModelRequestSchema,
  RegisterModelRequestSchema,
  RollbackModelRequestSchema,
} from '@triageai/contracts';
import type { EvalReportDto, ModelAssetDto, ModelStatus } from '@triageai/contracts';
import type { Database, Kernel } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';
import { AppError } from '../platform/errors.js';
import { DbModelRegistry, evaluatePromotion, modelDto } from '../services/modelRegistry.js';

interface ModelRow {
  [key: string]: unknown;
  id: string;
  component: string;
  name: string;
  artifact_ref: string | null;
  config: Record<string, unknown> | null;
  eval_report_id: string | null;
  status: ModelStatus;
  promoted_at: Date | string | null;
  created_at: Date | string;
}

interface EvalReportRow {
  [key: string]: unknown;
  id: string;
  subject_model_id: string | null;
  baseline_model_id: string | null;
  suites: Array<Record<string, unknown>>;
  metrics: Record<string, unknown>;
  passes: boolean;
  generated_at: Date | string;
  artifact: string | null;
  notes: string | null;
  created_at: Date | string;
}

function reportDto(row: EvalReportRow): EvalReportDto {
  return {
    id: row.id,
    generatedAt: new Date(row.generated_at).toISOString(),
    subjectModelId: row.subject_model_id,
    baselineModelId: row.baseline_model_id,
    suites: row.suites as EvalReportDto['suites'],
    metrics: row.metrics as EvalReportDto['metrics'],
    passes: row.passes,
    artifact: row.artifact,
    notes: row.notes,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

type Queryable = Pick<Database, 'query'>;

async function loadReport(database: Queryable, id: string): Promise<EvalReportRow> {
  const rows = (await database.query<EvalReportRow>(`SELECT * FROM eval_reports WHERE id = $1`, [
    id,
  ])) as unknown as EvalReportRow[];
  const row = rows[0];
  if (!row) throw new AppError('NOT_FOUND', `eval report ${id} not found`);
  return row;
}

export function registerModelRoutes(
  app: FastifyInstance,
  kernel: Kernel,
  registry: DbModelRegistry,
): void {
  app.get('/api/v1/models', async (request) => {
    const query = request.query as { component?: string; limit?: string };
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
    const rows = (await kernel.database.query<ModelRow>(
      `SELECT * FROM model_assets
       WHERE ($1::text IS NULL OR component = $1)
       ORDER BY created_at DESC LIMIT $2`,
      [query.component ?? null, limit],
    )) as unknown as ModelRow[];
    const dtos: ModelAssetDto[] = [];
    for (const row of rows) {
      const dto = modelDto(row);
      dto.evalReport = row.eval_report_id
        ? reportDto(await loadReport(kernel.database, row.eval_report_id))
        : null;
      dtos.push(dto);
    }
    return dtos;
  });

  app.get('/api/v1/models/eval-reports', async (request) => {
    const query = request.query as { limit?: string };
    const rawLimit = Number(query.limit ?? 50);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 200) : 50;
    const rows = (await kernel.database.query<EvalReportRow>(
      `SELECT * FROM eval_reports ORDER BY created_at DESC LIMIT $1`,
      [limit],
    )) as unknown as EvalReportRow[];
    return rows.map(reportDto);
  });

  app.post('/api/v1/models/eval-reports', async (request, reply) => {
    const body = EvalReportInputSchema.parse(request.body);
    if (body.subjectModelId) {
      const rows = (await kernel.database.query<ModelRow>(
        `SELECT * FROM model_assets WHERE id = $1`,
        [body.subjectModelId],
      )) as unknown as ModelRow[];
      if (!rows[0]) throw new AppError('NOT_FOUND', `model ${body.subjectModelId} not found`);
    }
    if (body.baselineModelId) {
      const rows = (await kernel.database.query<ModelRow>(
        `SELECT * FROM model_assets WHERE id = $1`,
        [body.baselineModelId],
      )) as unknown as ModelRow[];
      if (!rows[0]) throw new AppError('NOT_FOUND', `model ${body.baselineModelId} not found`);
    }
    const id = ulid();
    const inserted = (await kernel.database.query<EvalReportRow>(
      `INSERT INTO eval_reports
         (id, subject_model_id, baseline_model_id, suites, metrics, passes, generated_at, artifact, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        id,
        body.subjectModelId ?? null,
        body.baselineModelId ?? null,
        body.suites,
        body.metrics,
        body.passes,
        body.generatedAt,
        body.artifact ?? null,
        body.notes ?? null,
      ],
    )) as unknown as EvalReportRow[];
    if (body.subjectModelId) {
      await kernel.database.query(
        `UPDATE model_assets
           SET eval_report_id = $2,
               status = CASE WHEN status = 'registered' THEN 'candidate' ELSE status END
         WHERE id = $1`,
        [body.subjectModelId, id],
      );
    }
    await writeAudit(kernel.database, {
      actor: 'eval',
      action: 'eval_report.ingested',
      subject: id,
      payload: {
        subjectModelId: body.subjectModelId ?? null,
        baselineModelId: body.baselineModelId ?? null,
        passes: body.passes,
        suites: body.suites.map((suite) => suite.suite),
      },
    });
    return reply.status(201).send(reportDto(inserted[0] as EvalReportRow));
  });

  app.post('/api/v1/models', async (request, reply) => {
    const body = RegisterModelRequestSchema.parse(request.body);
    if (body.evalReportId) await loadReport(kernel.database, body.evalReportId);
    if (
      body.component === 'classifier' &&
      body.config.kind === 'linear-probe' &&
      !body.artifactRef
    ) {
      throw new AppError(
        'CONFLICT',
        'a linear-probe classifier must declare artifactRef (resolved by the ai-service)',
      );
    }
    const id = ulid();
    const rows = (await kernel.database.query<ModelRow>(
      `INSERT INTO model_assets (id, component, name, artifact_ref, config, eval_report_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        id,
        body.component,
        body.name,
        body.artifactRef ?? null,
        body.config,
        body.evalReportId ?? null,
        body.evalReportId ? 'candidate' : 'registered',
      ],
    )) as unknown as ModelRow[];
    await writeAudit(kernel.database, {
      actor: body.actor,
      action: 'model.registered',
      subject: id,
      payload: {
        component: body.component,
        name: body.name,
        evalReportId: body.evalReportId ?? null,
        artifactRef: body.artifactRef ?? null,
      },
    });
    return reply.status(201).send(modelDto(rows[0] as ModelRow));
  });

  app.post('/api/v1/models/:id/promote', async (request) => {
    const { id } = request.params as { id: string };
    const body = PromoteModelRequestSchema.parse(request.body ?? {});
    const outcome = await kernel.database.transaction(async (tx) => {
      const assetRows = (await tx.query<ModelRow>(
        `SELECT * FROM model_assets WHERE id = $1 FOR UPDATE`,
        [id],
      )) as unknown as ModelRow[];
      const asset = assetRows[0];
      if (!asset) throw new AppError('NOT_FOUND', `model ${id} not found`);
      if (asset.status === 'active') {
        throw new AppError('CONFLICT', `model ${id} is already active`);
      }
      const reportId = body.evalReportId ?? asset.eval_report_id;
      if (!reportId) {
        throw new AppError('CONFLICT', `model ${id} has no eval report; promotion is blocked`);
      }
      const reportRows = (await tx.query<EvalReportRow>(
        `SELECT * FROM eval_reports WHERE id = $1`,
        [reportId],
      )) as unknown as EvalReportRow[];
      const report = reportRows[0];
      if (!report) throw new AppError('NOT_FOUND', `eval report ${reportId} not found`);
      if (report.subject_model_id && report.subject_model_id !== id) {
        throw new AppError(
          'CONFLICT',
          `eval report ${reportId} belongs to model ${report.subject_model_id}, not ${id}`,
        );
      }

      const baselineRows = (await tx.query<ModelRow>(
        `SELECT * FROM model_assets
         WHERE component = $1 AND status = 'active' AND id <> $2
         FOR UPDATE`,
        [asset.component, id],
      )) as unknown as ModelRow[];
      const baseline = baselineRows[0];
      const baselineReport = baseline?.eval_report_id
        ? await loadReport(tx, baseline.eval_report_id)
        : null;
      const decision = evaluatePromotion(report, baselineReport);
      if (!decision.allowed) {
        throw new AppError('CONFLICT', `promotion blocked: ${decision.reasons.join('; ')}`, {
          reasons: decision.reasons,
        });
      }
      if (baseline) {
        await tx.query(`UPDATE model_assets SET status = 'rolled_back' WHERE id = $1`, [
          baseline.id,
        ]);
      }
      const promoted = (await tx.query<ModelRow>(
        `UPDATE model_assets
           SET status = 'active', eval_report_id = $2, promoted_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, reportId],
      )) as unknown as ModelRow[];
      return {
        asset: promoted[0] as ModelRow,
        previous: baseline?.id ?? null,
        reportId,
        reasons: decision.reasons,
      };
    });
    registry.invalidate();
    await writeAudit(kernel.database, {
      actor: body.actor,
      action: 'model.promoted',
      subject: id,
      payload: {
        component: outcome.asset.component,
        name: outcome.asset.name,
        evalReportId: outcome.reportId,
        previousModelId: outcome.previous,
      },
    });
    const dto = modelDto(outcome.asset);
    dto.evalReport = reportDto(await loadReport(kernel.database, outcome.reportId));
    return dto;
  });

  app.post('/api/v1/models/:id/rollback', async (request) => {
    const { id } = request.params as { id: string };
    const body = RollbackModelRequestSchema.parse(request.body ?? {});
    const outcome = await kernel.database.transaction(async (tx) => {
      const targetRows = (await tx.query<ModelRow>(
        `SELECT * FROM model_assets WHERE id = $1 FOR UPDATE`,
        [id],
      )) as unknown as ModelRow[];
      const target = targetRows[0];
      if (!target) throw new AppError('NOT_FOUND', `model ${id} not found`);
      if (target.status === 'active') {
        throw new AppError('CONFLICT', `model ${id} is already active`);
      }
      if (target.status !== 'rolled_back' || !target.promoted_at) {
        throw new AppError(
          'CONFLICT',
          `model ${id} was not previously active; rollback targets a rolled-back asset`,
        );
      }
      if (target.eval_report_id) {
        const report = await loadReport(tx, target.eval_report_id);
        if (!report.passes) {
          throw new AppError(
            'CONFLICT',
            `model ${id} has a failing eval report; refusing rollback`,
          );
        }
      }
      const currentRows = (await tx.query<ModelRow>(
        `SELECT * FROM model_assets
         WHERE component = $1 AND status = 'active' AND id <> $2
         FOR UPDATE`,
        [target.component, id],
      )) as unknown as ModelRow[];
      const current = currentRows[0];
      if (!current) {
        throw new AppError('CONFLICT', `no active ${target.component} model to roll back from`);
      }
      await tx.query(`UPDATE model_assets SET status = 'rolled_back' WHERE id = $1`, [current.id]);
      const activated = (await tx.query<ModelRow>(
        `UPDATE model_assets SET status = 'active', promoted_at = now() WHERE id = $1 RETURNING *`,
        [id],
      )) as unknown as ModelRow[];
      return { asset: activated[0] as ModelRow, previous: current.id };
    });
    registry.invalidate();
    await writeAudit(kernel.database, {
      actor: body.actor,
      action: 'model.rolled_back',
      subject: id,
      payload: {
        component: outcome.asset.component,
        name: outcome.asset.name,
        fromModelId: outcome.previous,
        reason: body.reason ?? null,
      },
    });
    return modelDto(outcome.asset);
  });
}
