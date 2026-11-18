import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { ulid } from 'ulid';

import { AgentDefinitionSchema } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { watchdogScanAndPause } from '../src/services/agents.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

const definition = AgentDefinitionSchema.parse({
  id: 'test-monitor-agent',
  displayName: 'Monitor Agent',
  color: '#3b6fd4',
  version: 1,
  profile: 'A test agent.',
  job: {
    role: 'test the monitor',
    inputs: 'a goal',
    output: 'a step',
    doneWhen: 'the monitor lists it',
    domain: 'test',
  },
  agentReason: ['own_schedule'],
  tools: [],
  scopes: [],
  maxSteps: 2,
  egressClass: 'internal',
});

let app: App;
beforeEach(async () => {
  app = (await buildApp({
    quiet: true,
    configPath: resolve(process.cwd(), '../../triage.config.json'),
  })) as App;
});
afterEach(async () => {
  const db = app.kernel?.database;
  if (db) {
    await db.query(`DELETE FROM agent_definitions WHERE id = $1`, [definition.id]);
    await db.query(`DELETE FROM agent_definitions WHERE id = 'test-created-agent'`);
    await db.query(`DELETE FROM shared_state WHERE scope_type = 'agent' AND scope_id = $1`, [
      definition.id,
    ]);
    await db.query(`DELETE FROM shared_state WHERE scope_type = 'agent' AND scope_id = $1`, [
      'test-watchdog-agent',
    ]);
    await db.query(`DELETE FROM agent_steps WHERE run_id LIKE 'test-watchdog-%'`);
    await db.query(`DELETE FROM workflow_runs WHERE id LIKE 'test-watchdog-%'`);
    await db.query(`DELETE FROM settings WHERE key = 'plugins.agentProfiles'`);
  }
  await app.close();
});

describeIfDb('/agents monitor (phase 17.T2)', () => {
  it('creates an agent definition with the job fields and refuses a missing reason', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { ...definition, id: 'test-created-agent', displayName: 'Created Agent' },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      id: 'test-created-agent',
      displayName: 'Created Agent',
    });
    const listed = await app.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(
      (listed.json() as { agents: Array<{ id: string }> }).agents.some(
        (agent) => agent.id === 'test-created-agent',
      ),
    ).toBe(true);
    const invalidAgent = await app.inject({
      method: 'POST',
      url: '/api/v1/agents',
      payload: { ...definition, id: 'test-created-agent-2', agentReason: [] },
    });
    expect(invalidAgent.statusCode).toBe(400);
  });

  it('lists definitions, pauses and resumes with an audit row', async () => {
    await app.kernel!.database.query(
      `INSERT INTO agent_definitions (id, display_name, version, definition)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition`,
      [definition.id, definition.displayName, definition],
    );
    await app.kernel!.database.query(
      `INSERT INTO settings (key, value) VALUES ('plugins.agentProfiles', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        {
          profiles: [
            {
              name: 'Pack Reviewer',
              packId: 'demo-pack',
              body: '# Reviewer',
              importedAt: new Date().toISOString(),
            },
          ],
        },
      ],
    );

    const listed = await app.inject({ method: 'GET', url: '/api/v1/agents' });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as {
      agents: Array<{ id: string; status: string }>;
      packProfiles: Array<{ name: string; packId: string; readOnly: boolean; source: string }>;
    };
    expect(body.agents.find((agent) => agent.id === definition.id)?.status).toBe('off');
    expect(body.packProfiles).toEqual([
      expect.objectContaining({
        name: 'Pack Reviewer',
        packId: 'demo-pack',
        readOnly: true,
        source: 'pack',
      }),
    ]);

    const paused = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${definition.id}/pause`,
      payload: { reason: 'test pause' },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json()).toMatchObject({ agentId: definition.id, paused: true });

    const detail = await app.inject({ method: 'GET', url: `/api/v1/agents/${definition.id}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ agent: { paused: true, status: 'paused' } });

    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE subject = $1 AND action = 'agent.paused'`,
      [definition.id],
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/v1/agents/${definition.id}/resume`,
      payload: { reason: 'test resume' },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({ agentId: definition.id, paused: false });
  });

  it('pauses an agent whose last three tool calls are identical (audited)', async () => {
    const runId = `test-watchdog-${ulid()}`;
    await app.kernel!.database.query(
      `INSERT INTO workflow_runs (id, workflow_id, workflow_version, trigger, status, input)
       VALUES ($1, 'agent.run', '1', 'endpoint', 'RUNNING', $2)`,
      [runId, { agentId: 'test-watchdog-agent', definition, goal: 'loop' }],
    );
    for (let step = 0; step < 3; step += 1) {
      await app.kernel!.database.query(
        `INSERT INTO agent_steps (id, run_id, step_no, decision, payload)
         VALUES ($1, $2, $3, 'call_tool', $4)`,
        [
          ulid(),
          runId,
          step,
          { decision: 'call_tool', tool: 'kb.search', args: { query: 'same' }, reason: 'again' },
        ],
      );
    }
    const findings = await watchdogScanAndPause(app.kernel!);
    expect(findings).toEqual([
      { agentId: 'test-watchdog-agent', action: 'pause', reason: 'three_identical_tool_calls' },
    ]);
    const paused = await app.kernel!.database.query<{ value: { paused: boolean } }>(
      `SELECT value FROM shared_state WHERE scope_type = 'agent' AND scope_id = $1 AND key = 'paused'`,
      ['test-watchdog-agent'],
    );
    expect(paused[0]?.value.paused).toBe(true);
    const audit = await app.kernel!.database.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE subject = $1 AND action = 'agent.watchdog.pause'`,
      ['test-watchdog-agent'],
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a team with more than six agents', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/teams/run',
      payload: {
        teamId: 'too-big',
        topology: 'pipeline',
        agents: Array.from({ length: 7 }, (_, index) => ({
          id: `agent-${index}`,
          definition: { ...definition, id: `agent-${index}` },
          goal: 'work',
        })),
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
