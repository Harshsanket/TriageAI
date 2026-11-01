import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

let app: App;
beforeEach(async () => {
  app = (await buildApp({
    quiet: true,
    configPath: resolve(process.cwd(), '../../triage.config.json'),
  })) as App;
});
afterEach(async () => {
  await app.close();
});

describeIfDb('run graph endpoint (phase 18)', () => {
  it('returns the compiled graph and the taken path for a run', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/echo/run',
      payload: { text: 'graph me' },
    });
    expect(created.statusCode).toBe(200);
    const { runId } = created.json() as { runId: string };
    const res = await app.inject({ method: 'GET', url: `/api/v1/system/runs/${runId}/graph` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      workflowId: string;
      graph: { nodes: Array<{ id: string }> };
      takenEdges: string[];
    };
    expect(body.workflowId).toBe('echo.run');
    expect(body.graph.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(body.takenEdges)).toBe(true);
  });
});
