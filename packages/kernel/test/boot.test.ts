import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { bootKernel } from '../src/kernel.js';
import type { Kernel } from '../src/kernel.js';
import { PostgresDatabase } from '../src/storage.js';
import type { KernelContext, KernelLogger, TriageModule } from '../src/types.js';

const noopLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

function demoModule(): TriageModule {
  return {
    id: 'demo',
    version: '0.1.0',
    capabilities: [],
    dependsOn: {},
    manifest: {
      routes: [],
      nav: [{ path: '/demo', label: 'Demo', order: 1 }],
      background: [],
    },
    lifecycle: {},
    configSchema: z.object({ greet: z.string().default('hello') }).passthrough(),
    register(context: KernelContext) {
      context.registerStageHandler('demo.upper', {
        execute: async (stage) => {
          const data = (stage.data['input'] ?? {}) as { text?: string };
          return {
            output: { upper: String(data.text ?? '').toUpperCase() },
            evidence: { kind: 'deterministic' as const, values: { policy: 'upper' } },
            deterministic: data ?? null,
          };
        },
      });
      context.registerStageHandler('demo.wrap', {
        execute: async (stage) => {
          const data = (stage.data['upper'] ?? {}) as { upper?: string };
          return {
            output: { wrapped: `[${data.upper ?? ''}]` },
            evidence: { kind: 'deterministic' as const, values: { policy: 'wrap' } },
            deterministic: data ?? null,
          };
        },
      });
      context.registerRoute({
        method: 'POST',
        url: '/api/v1/demo/run',
        handler: async (request) => {
          const result = await context.queue.startWorkflow('demo.wf', request.body);
          return result;
        },
      });
      context.queue.start({
        id: 'demo.wf',
        module: 'demo',
        version: '0.1.0',
        trigger: { type: 'endpoint' },
        stages: [
          { id: 'upper', kind: 'demo.upper', input: { text: '$.text' } },
          { id: 'wrap', kind: 'demo.wrap', input: { upper: '$.stages.upper.output.upper' } },
        ],
      });
    },
  };
}

async function pollFor<K>(
  fn: () => Promise<{ done: boolean; value?: K }>,
  timeoutMs = 10000,
): Promise<K | undefined> {
  const started = Date.now();
  for (;;) {
    const state = await fn();
    if (state.done) return state.value;
    if (Date.now() - started > timeoutMs) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeIfDb('bootKernel', () => {
  it('validates module graph, applies migrations, runs a workflow, and writes decisions', async () => {
    const database = new PostgresDatabase(DATABASE_URL);
    const kernel: Kernel = await bootKernel({
      config: {
        profile: 'core',
        queue: { adapter: 'inline', pollIntervalMs: 10 },
        modules: { demo: { enabled: true, options: { greet: 'hi' } } },
        capabilities: {},
      },
      database,
      logger: noopLogger,
      modules: { demo: demoModule() },
    });

    try {
      // routes from modules reach the host
      const routes = kernel.routes();
      expect(routes).toHaveLength(1);
      expect(routes[0].url).toBe('/api/v1/demo/run');

      // manifest contains the module
      const manifest = kernel.manifest();
      expect(manifest.modules.map((m) => m.id)).toEqual(['demo']);
      expect(manifest.modules[0]?.manifest.nav[0]?.path).toBe('/demo');

      // trigger the workflow through the module route handler
      const route = routes[0];
      const started = (await route.handler({
        method: 'POST',
        url: '/api/v1/demo/run',
        body: { text: 'ship it' },
        params: {},
        query: {},
      })) as { runId: string };

      // the inline queue disposed at kernel shutdown; wait for projection
      const completed = await pollFor(async () => {
        const rows = (await kernel.database.query(
          `SELECT status FROM workflow_runs WHERE id = $1`,
          [started.runId],
        )) as Array<{ status: string }>;
        return {
          done: rows.length === 1 && rows[0]?.status === 'SUCCEEDED',
          value: rows[0]?.status,
        };
      });
      expect(completed).toBe('SUCCEEDED');

      const stageRows = (await kernel.database.query(
        `SELECT stage_id, status FROM stage_runs WHERE run_id = $1 ORDER BY created_at`,
        [started.runId],
      )) as Array<{ stage_id: string; status: string }>;
      expect(stageRows.map((r) => r.stage_id)).toEqual(['upper', 'wrap']);
      expect(stageRows.every((r) => r.status === 'SUCCEEDED')).toBe(true);

      const decisions = (await kernel.database.query(
        `SELECT module_id, workflow_id, stage_run_id FROM decision_records
         WHERE run_id = $1 ORDER BY created_at`,
        [started.runId],
      )) as Array<{ module_id: string; workflow_id: string; stage_run_id: string }>;
      expect(decisions.map((d) => d.module_id)).toEqual(['demo', 'demo']);
      expect(decisions.every((d) => d.workflow_id === 'demo.wf')).toBe(true);
      expect(decisions).toHaveLength(2);
    } finally {
      await kernel.shutdown();
      await database.close();
    }
  }, 30000);

  it('rejects invalid module options with a typed error', async () => {
    const database = new PostgresDatabase(DATABASE_URL);
    await expect(
      bootKernel({
        config: {
          profile: 'core',
          queue: { adapter: 'inline' },
          modules: { demo: { enabled: true, options: { greet: 42 } } },
          capabilities: {},
        },
        database,
        logger: noopLogger,
        modules: { demo: demoModule() },
      }),
    ).rejects.toMatchObject({ code: 'kernel.CONFIG_INVALID' });
    await database.close();
  });

  it('refuses uninstall of an enabled module and drops a disabled one', async () => {
    const database = new PostgresDatabase(DATABASE_URL);
    // enabled: uninstall must conflict
    const kernel = await bootKernel({
      config: {
        profile: 'core',
        queue: { adapter: 'inline' },
        modules: { demo: { enabled: true } },
        capabilities: {},
      },
      database,
      logger: noopLogger,
      modules: { demo: demoModule() },
    });
    await expect(kernel.uninstallModule('demo')).rejects.toMatchObject({ code: 'kernel.CONFLICT' });
    await kernel.shutdown();
    await database.close();

    // disabled: uninstall drops the module table (fake module has no migrations -> no-op success)
    const database2 = new PostgresDatabase(DATABASE_URL);
    const kernel2 = await bootKernel({
      config: {
        profile: 'core',
        queue: { adapter: 'inline' },
        modules: { demo: { enabled: false } },
        capabilities: {},
      },
      database: database2,
      logger: noopLogger,
      modules: { demo: demoModule() },
    });
    const result = await kernel2.uninstallModule('demo');
    expect(result.dropped).toEqual([]);
    await kernel2.shutdown();
    await database2.close();
  }, 30000);
});
