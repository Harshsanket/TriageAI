import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentDefinition } from '../src/agents/runtime.js';
import { prepareTeamRun, registerTeamWorkflow } from '../src/agents/workflow.js';
import { CORE_MIGRATIONS } from '../src/migrations.js';
import { MigrationRunner, PostgresDatabase } from '../src/storage.js';
import type { KernelLogger, QueueCapability } from '../src/types.js';
import { WorkflowEngine } from '../src/workflow.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const logger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function agent(id: string): AgentDefinition {
  return {
    id,
    displayName: id,
    version: 1,
    profile: 'Fake agent for team topology tests.',
    job: {
      role: 'run one step',
      inputs: 'goal',
      output: 'done',
      doneWhen: 'the fake step returned',
      domain: 'test',
    },
    agentReason: ['own_schedule'],
    tools: [],
    scopes: [],
    maxSteps: 2,
    egressClass: 'internal',
  };
}

let database: PostgresDatabase;
const runIds: string[] = [];
beforeAll(async () => {
  database = new PostgresDatabase(DATABASE_URL);
  await new MigrationRunner(database, logger).apply('kernel', CORE_MIGRATIONS);
});
afterAll(async () => {
  if (runIds.length > 0) {
    await database.query(`DELETE FROM stage_runs WHERE run_id = ANY($1)`, [runIds]);
    await database.query(`DELETE FROM decision_records WHERE run_id = ANY($1)`, [runIds]);
    await database.query(`DELETE FROM workflow_runs WHERE id = ANY($1)`, [runIds]);
  }
  await database.close();
});

function makeEngine(): WorkflowEngine {
  const ref: { engine?: WorkflowEngine } = {};
  const queue: QueueCapability = {
    start: () => undefined,
    async startWorkflow(workflowId, input, opts) {
      const engine = ref.engine as WorkflowEngine;
      const started = await engine.start(workflowId, input, opts);
      runIds.push(started.runId);
      await engine.processRun(started.runId);
      return started;
    },
    registerWorker: () => undefined,
    drain: async () => undefined,
  };
  const engine = new WorkflowEngine(database, logger, undefined, queue);
  ref.engine = engine;
  return engine;
}

describeIfDb('team.run graphs (phase 17.T1)', () => {
  it('runs a pipeline of agent subworkflows and a fan-out in parallel', async () => {
    const engine = makeEngine();
    engine.registerStageHandler('fake.agent', {
      execute: async (stage) => ({ output: { goal: stage.input.goal, done: true } }),
    });
    engine.register(
      {
        id: 'agent.fake',
        version: '1',
        module: 'kernel',
        trigger: { type: 'endpoint' },
        stages: [{ id: 'run', kind: 'fake.agent' }],
      },
      'kernel',
      '1.0.0',
    );

    const pipeline = registerTeamWorkflow(engine, {
      teamId: 'pipe',
      topology: 'pipeline',
      agents: [
        { id: 'a', definition: agent('a'), goal: 'first', workflowId: 'agent.fake' },
        { id: 'b', definition: agent('b'), goal: 'second', workflowId: 'agent.fake' },
      ],
    });
    const pipeRun = await engine.start(pipeline.workflowId, pipeline.workflowInput);
    runIds.push(pipeRun.runId);
    await engine.processRun(pipeRun.runId);
    const pipeStatus = await database.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE id = $1`,
      [pipeRun.runId],
    );
    expect(pipeStatus[0]?.status).toBe('SUCCEEDED');
    const pipeNodes = await database.query<{ stage_id: string; status: string }>(
      `SELECT stage_id, status FROM stage_runs WHERE run_id = $1 AND stage_id LIKE 'agent-%' ORDER BY stage_id`,
      [pipeRun.runId],
    );
    expect(pipeNodes).toEqual([
      { stage_id: 'agent-1', status: 'SUCCEEDED' },
      { stage_id: 'agent-2', status: 'SUCCEEDED' },
    ]);

    const fanout = registerTeamWorkflow(engine, {
      teamId: 'fan',
      topology: 'fanout',
      agents: [
        { id: 'a', definition: agent('a'), goal: 'left', workflowId: 'agent.fake' },
        { id: 'b', definition: agent('b'), goal: 'right', workflowId: 'agent.fake' },
      ],
    });
    const fanRun = await engine.start(fanout.workflowId, fanout.workflowInput);
    runIds.push(fanRun.runId);
    await engine.processRun(fanRun.runId);
    const fanStatus = await database.query<{ status: string }>(
      `SELECT status FROM workflow_runs WHERE id = $1`,
      [fanRun.runId],
    );
    expect(fanStatus[0]?.status).toBe('SUCCEEDED');
    const fanNodes = await database.query<{ stage_id: string }>(
      `SELECT stage_id FROM stage_runs WHERE run_id = $1 AND stage_id LIKE 'agent-%' ORDER BY stage_id`,
      [fanRun.runId],
    );
    expect(fanNodes.map((node) => node.stage_id)).toEqual(['agent-1', 'agent-2']);
  });

  it('registers pipeline, supervisor, reviewer and fan-out graphs', () => {
    const engine = makeEngine();
    for (const topology of ['pipeline', 'supervisor', 'reviewer', 'fanout'] as const) {
      const prepared = registerTeamWorkflow(engine, {
        teamId: `shape-${topology}`,
        topology,
        agents: [
          { id: 'a', definition: agent('a'), goal: 'first' },
          { id: 'b', definition: agent('b'), goal: 'second' },
        ],
      });
      expect(engine.graphFor(prepared.workflowId)?.nodes.length).toBeGreaterThan(2);
    }
  });

  it('refuses a seventh agent', () => {
    expect(() =>
      prepareTeamRun({
        teamId: 'too-big',
        topology: 'pipeline',
        agents: Array.from({ length: 7 }, (_, index) => ({
          id: `a${index}`,
          definition: agent(`a${index}`),
          goal: 'work',
        })),
      }),
    ).toThrow();
  });
});
