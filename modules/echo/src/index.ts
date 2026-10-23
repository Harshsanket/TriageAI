/**
 * Echo module: the Phase 1 reference module (DEVELOPMENT_PLAN §Phase 1).
 * Demonstrates the full surface: config options, a migration, two stages,
 * one linear workflow, HTTP routes, manifest gating, and a background poller.
 */
import { ulid } from 'ulid';
import { z } from 'zod';

import type { TriageModule } from '@triageai/kernel';
import { RunDtoSchema, StageRunDtoSchema } from '@triageai/contracts';

const MIGRATIONS = [
  {
    id: '0001-echo-notes',
    sql: `
      CREATE TABLE IF NOT EXISTS echo_notes (
        id        TEXT PRIMARY KEY,
        org_id    TEXT REFERENCES orgs(id) ON DELETE SET NULL,
        run_id    TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
        text      TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
    dropSql: 'DROP TABLE IF EXISTS echo_notes;',
  },
];

const configSchema = z
  .object({
    suffix: z.string().default(''),
    maxTextLength: z.number().int().positive().max(10_000).default(2000),
  })
  .strict();

export function createEchoModule(): TriageModule {
  return {
    id: 'echo',
    version: '0.1.0',
    capabilities: ['queue', 'eventBus', 'storage'],
    dependsOn: { modules: [], capabilities: [] },
    configSchema,
    migrations: MIGRATIONS,
    tables: ['echo_notes'],
    manifest: {
      routes: [{ path: '/echo', title: 'Echo' }],
      nav: [{ label: 'Echo', order: 10, path: '/echo' }],
      background: [{ query: 'GET /api/v1/echo/runs?limit=5', intervalMs: 30000 }],
    },
    lifecycle: {
      health: async () => ({ status: 'healthy', detail: 'echo module serving' }),
    },
    register(ctx) {
      const options = configSchema.parse(ctx.moduleOptions ?? {});

      ctx.registerStageHandler('echo.upper', {
        inputSchema: z.object({ text: z.string() }).passthrough(),
        execute: async (stage) => {
          const data = (stage.data['input'] ?? {}) as { text?: string };
          const text = String(data.text ?? '');
          return {
            output: { upper: `${text.toUpperCase()}${options.suffix}` },
            evidence: { kind: 'deterministic', values: { policy: 'upper' } },
            deterministic: { text },
          };
        },
      });

      ctx.registerStageHandler('echo.wrap', {
        inputSchema: z.object({ upper: z.string() }).passthrough(),
        execute: async (stage) => {
          const data = (stage.data['upper'] ?? {}) as { upper?: string };
          const upper = String(data.upper ?? '');
          return {
            output: { wrapped: `[${upper}]` },
            evidence: { kind: 'deterministic', values: { policy: 'wrap' } },
            deterministic: { upper },
          };
        },
      });

      ctx.queue.start({
        id: 'echo.run',
        module: 'echo',
        version: '0.1.0',
        trigger: { type: 'endpoint' },
        stages: [
          { id: 'upper', kind: 'echo.upper', input: { text: '$.text' } },
          { id: 'wrap', kind: 'echo.wrap', input: { upper: '$.stages.upper.output.upper' } },
        ],
      });

      ctx.registerRoute({
        method: 'POST',
        url: '/api/v1/echo/run',
        handler: async (request) => {
          const body = z
            .object({ text: z.string().min(1).max(options.maxTextLength) })
            .parse(request.body);
          return ctx.queue.startWorkflow('echo.run', { text: body.text }, { trigger: 'endpoint' });
        },
      });

      ctx.registerRoute({
        method: 'POST',
        url: '/api/v1/echo/note',
        handler: async (request) => {
          const body = z
            .object({ text: z.string().min(1).max(options.maxTextLength) })
            .parse(request.body);
          const id = ulid();
          await ctx.database.query(`INSERT INTO echo_notes (id, text) VALUES ($1, $2)`, [
            id,
            body.text,
          ]);
          return { id, text: body.text };
        },
      });

      ctx.registerRoute({
        method: 'GET',
        url: '/api/v1/echo/runs',
        handler: async (request) => {
          const rawLimit = Number(request.query.limit ?? 10);
          const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 10;
          interface RunRow {
            [key: string]: unknown;
            id: string;
            workflow_id: string;
            workflow_version: string;
            trigger: string;
            status: string;
            input: unknown;
            output: Record<string, unknown> | null;
            error: string | null;
            created_at: Date | string;
            finished_at: Date | string | null;
          }
          interface StageRow {
            [key: string]: unknown;
            id: string;
            run_id: string;
            stage_id: string;
            kind: string;
            status: string;
            attempts: number;
            output: unknown;
            error: string | null;
            started_at: Date | string | null;
            finished_at: Date | string | null;
          }
          const runs = await ctx.database.query<RunRow>(
            `SELECT id, workflow_id, workflow_version, trigger, status, input, output, error,
                    created_at, finished_at
             FROM workflow_runs WHERE workflow_id = 'echo.run' ORDER BY created_at DESC LIMIT $1`,
            [limit],
          );
          const stageRows = await ctx.database.query<StageRow>(
            `SELECT s.id, s.run_id, s.stage_id, s.kind, s.status, s.attempts, s.output, s.error,
                    s.started_at, s.finished_at
             FROM stage_runs s JOIN workflow_runs r ON r.id = s.run_id
             WHERE r.workflow_id = 'echo.run'
             ORDER BY s.created_at DESC LIMIT ${limit * 10}`,
          );
          const byRun = new Map<string, StageRow[]>();
          for (const row of stageRows)
            byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row]);
          return runs.map((run) => {
            const stages = (byRun.get(run.id) ?? []).map((s) =>
              StageRunDtoSchema.parse({
                id: s.id,
                runId: s.run_id,
                stageId: s.stage_id,
                kind: s.kind,
                status: s.status,
                attempts: s.attempts,
                output: s.output ?? null,
                error: s.error ?? null,
                startedAt: s.started_at ? new Date(s.started_at).toISOString() : null,
                finishedAt: s.finished_at ? new Date(s.finished_at).toISOString() : null,
              }),
            );
            const runDto = RunDtoSchema.parse({
              id: run.id,
              workflowId: run.workflow_id,
              workflowVersion: run.workflow_version,
              trigger: run.trigger,
              status: run.status,
              input: run.input ?? null,
              output: run.output ?? null,
              error: run.error ?? null,
              createdAt: new Date(run.created_at).toISOString(),
              finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
            });
            return { ...runDto, stages } as Record<string, unknown>;
          });
        },
      });
    },
  };
}

export const echoModule: TriageModule = createEchoModule();
