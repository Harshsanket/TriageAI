/** Run-history execution-style suggestions (Phase 18.T23). */
import { suggestPipeline } from '@triageai/kernel';
import type { Database } from '@triageai/kernel';

export interface PipelineSuggestion {
  workflowId: string;
  runs: number;
  share: number;
  path: string[];
  suggest: boolean;
}

const TERMINAL = `('SUCCEEDED','FAILED','CANCELLED','AWAITING')`;

/**
 * If an agent workflow takes the same path in ≥95% of its last 100 runs,
 * suggest converting it to a pipeline (never convert automatically). Paths are
 * the ordered stage ids persisted by the engine; no side channel.
 */
export async function readPipelineSuggestions(
  database: Database,
  limit = 100,
): Promise<PipelineSuggestion[]> {
  const workflows = await database
    .query<{ workflow_id: string }>(
      `SELECT DISTINCT workflow_id FROM workflow_runs
        WHERE status IN ${TERMINAL} ORDER BY workflow_id`,
    )
    .catch(() => []);
  const out: PipelineSuggestion[] = [];
  for (const workflow of workflows) {
    const rows = await database
      .query<{ path: string[] | null }>(
        `SELECT array_agg(s.stage_id ORDER BY s.created_at, s.stage_id) AS path
           FROM workflow_runs r
           LEFT JOIN stage_runs s ON s.run_id = r.id
          WHERE r.workflow_id = $1 AND r.status IN ${TERMINAL}
          GROUP BY r.id
          ORDER BY max(r.finished_at) DESC NULLS LAST
          LIMIT $2`,
        [workflow.workflow_id, limit],
      )
      .catch(() => []);
    const paths = rows.map((row) => row.path ?? []).filter((path) => path.length > 0);
    if (paths.length < 10) continue;
    const result = suggestPipeline(paths, 0.95);
    out.push({
      workflowId: workflow.workflow_id,
      runs: paths.length,
      share: result.share,
      path: result.path ?? [],
      suggest: result.suggest,
    });
  }
  return out.sort((a, b) => b.share - a.share);
}
