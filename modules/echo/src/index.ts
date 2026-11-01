/**
 * Echo module: the Phase 1 reference module (DEVELOPMENT_PLAN §Phase 1).
 * Demonstrates the full surface: config options, a migration, two stages,
 * one linear workflow, HTTP routes, manifest gating, and a background poller.
 */
import { ulid } from 'ulid';
import { z } from 'zod';

import type { TriageModule } from '@triageai/kernel';

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
  {
    // ADR-0054 §3: module tables never carry a foreign key into a core table.
    // The original migration created `run_id REFERENCES workflow_runs(id)`;
    // applied databases get the FK dropped here (migrations are immutable).
    id: '0002-echo-drop-core-fks',
    sql: `
      ALTER TABLE echo_notes DROP CONSTRAINT IF EXISTS echo_notes_run_id_fkey;
      ALTER TABLE echo_notes DROP CONSTRAINT IF EXISTS echo_notes_org_id_fkey;
    `,
    dropSql: '',
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
    permissions: {
      storage: { schema: true },
      routes: [
        { method: 'GET', path: '/api/v1/echo/runs' },
        { method: 'POST', path: '/api/v1/echo/note' },
        { method: 'POST', path: '/api/v1/echo/run' },
      ],
      events: { publish: [], subscribe: [] },
      capabilities: { consume: ['queue', 'eventBus', 'storage'], provide: [] },
      stages: ['echo.upper', 'echo.wrap'],
      workflows: ['echo.run'],
      evals: [],
      tools: [],
      knowledge: { read: [], write: [] },
    },
    dependsOn: { capabilities: [] },
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
          const limit = Number.isFinite(rawLimit)
            ? Math.min(Math.max(1, Math.trunc(rawLimit)), 100)
            : 10;
          const runs = await ctx.runs.list({ workflowId: 'echo.run', limit });
          return runs.map(({ run, stages }) => ({ ...run, stages }));
        },
      });
    },
  };
}

export const echoModule: TriageModule = createEchoModule();
