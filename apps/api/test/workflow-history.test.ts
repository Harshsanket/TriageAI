import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresDatabase } from '@triageai/kernel';

import { readPipelineSuggestions } from '../src/services/workflowHistory.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const WORKFLOW = `test.suggest.${Date.now()}`;

describeIfDb('run-history pipeline suggestions (18.T23)', () => {
  let database: PostgresDatabase;

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    for (let index = 0; index < 20; index += 1) {
      const runId = `${WORKFLOW}-run-${index}`;
      await database.query(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version, status, finished_at)
         VALUES ($1, $2, '1.0.0', 'SUCCEEDED', now())`,
        [runId, WORKFLOW],
      );
      const path = index === 19 ? ['load', 'other', 'end'] : ['load', 'classify', 'end'];
      for (const stage of path) {
        await database.query(
          `INSERT INTO stage_runs (id, run_id, stage_id, kind, status)
           VALUES ($1, $2, $3, 'test.stage', 'SUCCEEDED')`,
          [`${runId}-${stage}`, runId, stage],
        );
      }
    }
  });

  afterAll(async () => {
    await database.query(`DELETE FROM stage_runs WHERE run_id LIKE $1`, [`${WORKFLOW}%`]);
    await database.query(`DELETE FROM workflow_runs WHERE workflow_id = $1`, [WORKFLOW]);
    await database.close();
  });

  it('suggests a pipeline when the path is stable in at least 95% of runs', async () => {
    const suggestions = await readPipelineSuggestions(database);
    const entry = suggestions.find((suggestion) => suggestion.workflowId === WORKFLOW);
    expect(entry).toMatchObject({ runs: 20, suggest: true });
    expect(entry?.share).toBeGreaterThanOrEqual(0.95);
    expect(entry?.path).toEqual(['load', 'classify', 'end']);
  });
});
