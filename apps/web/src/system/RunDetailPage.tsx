import { useEffect, useState } from 'react';
import type { DecisionRecordDto, RunDto, StageRunDto } from '@triageai/contracts';

import { navigate } from '../host/router';
import { apiFetch, type ApiFailure } from '../host/api';

interface RunDetail {
  run: RunDto;
  stages: StageRunDto[];
  decisions: Array<DecisionRecordDto & { fallback?: unknown; outcome?: unknown }>;
}

interface RunGraph {
  workflowId: string;
  version: string;
  graph: {
    nodes: Array<{ id: string; type: string; kind?: string }>;
    edges: Array<{ from: string; to: string; label: string }>;
  };
  takenEdges: string[];
}

const STATUS_COLORS: Record<string, string> = {
  SUCCEEDED: '#1a7f37',
  FAILED: '#cf222e',
  TIMED_OUT: '#cf222e',
  CANCELLED: '#9a6700',
  CANCELLED_PENDING: '#9a6700',
  SKIPPED: '#57606a',
  RUNNING: '#0969da',
  QUEUED: '#57606a',
  AWAITING: '#8250df',
};

/** Decision kinds surfaced as badges (ADR-0005 field kinds + fallback/outcome). */
function decisionBadges(decision: RunDetail['decisions'][number]): string[] {
  const badges: string[] = [];
  if (decision.evidence) badges.push('evidence');
  if (decision.deterministic) badges.push('deterministic');
  if (decision.fallback) badges.push('fallback');
  if (decision.error) badges.push('error');
  if (decision.outcome) badges.push('outcome');
  return badges;
}

export default function RunDetailPage({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<ApiFailure | string | null>(null);
  const [gold, setGold] = useState('');
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [graph, setGraph] = useState<RunGraph | null>(null);

  useEffect(() => {
    const disposed = false;
    const loadGraph = async () => {
      const res = await apiFetch<RunGraph>(`/api/v1/system/runs/${runId}/graph`);
      if (!disposed && res.ok && Array.isArray(res.data?.graph?.nodes)) setGraph(res.data);
    };
    void loadGraph();
  }, [runId]);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const res = await apiFetch<RunDetail>(`/api/v1/system/runs/${runId}`);
      if (!res.ok) {
        if (!disposed) setError(res.error);
        return;
      }
      if (!disposed) {
        setDetail(res.data);
        setError(null);
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [runId]);

  if (error)
    return <p role="alert">{typeof error === 'string' ? error : error.envelope.userMessage}</p>;
  if (!detail) return <p>Loading run…</p>;

  const submitCorrection = async (event: React.FormEvent) => {
    event.preventDefault();
    const res = await apiFetch('/api/v1/system/candidates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: run.id, input: run.input, gold, reason }),
    });
    setSaved(res.ok ? 'Correction saved as a candidate example.' : res.error.envelope.userMessage);
  };

  const { run, stages, decisions } = detail;
  const decisionsByStage = new Map<string, RunDetail['decisions']>();
  for (const decision of decisions) {
    decisionsByStage.set(decision.stageRunId, [
      ...(decisionsByStage.get(decision.stageRunId) ?? []),
      decision,
    ]);
  }

  return (
    <section>
      <button type="button" onClick={() => navigate('/runs')}>
        ← All runs
      </button>
      <h2 style={{ marginBottom: 4 }}>Run {run.id}</h2>
      <p style={{ marginTop: 0 }}>
        <strong>{run.workflowId}</strong> v{run.workflowVersion} · {run.trigger} ·{' '}
        <strong style={{ color: STATUS_COLORS[run.status] ?? 'inherit' }}>{run.status}</strong>
        {run.error ? <span style={{ color: '#cf222e' }}> — {run.error}</span> : null}
      </p>

      {graph && (
        <>
          <h3>Graph</h3>
          <p>
            {graph.workflowId} v{graph.version} · {graph.graph.nodes.length} nodes · taken path{' '}
            {graph.takenEdges.length > 0 ? graph.takenEdges.join(', ') : '—'}
          </p>
          <ol>
            {graph.graph.nodes.map((node) => (
              <li key={node.id}>
                <code>{node.id}</code> {node.type}
                {node.kind ? ` (${node.kind})` : ''}
              </li>
            ))}
          </ol>
        </>
      )}

      <h3>Input</h3>
      <pre>{JSON.stringify(run.input, null, 2)}</pre>

      <h3>Stages</h3>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Stage</th>
            <th align="left">Kind</th>
            <th align="left">Status</th>
            <th align="left">Attempts</th>
            <th align="left">Duration</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((stage) => {
            const stageDecisions = decisionsByStage.get(stage.id) ?? [];
            const duration =
              stage.startedAt && stage.finishedAt
                ? `${new Date(stage.finishedAt).getTime() - new Date(stage.startedAt).getTime()}ms`
                : '—';
            return (
              <tr key={stage.id} style={{ borderTop: '1px solid #ddd', verticalAlign: 'top' }}>
                <td>
                  {stage.stageId}
                  {stageDecisions.length > 0 && (
                    <ul style={{ margin: '4px 0 0 0', paddingLeft: 16 }}>
                      {stageDecisions.map((decision) => (
                        <li key={decision.id} style={{ fontSize: 12 }}>
                          {decisionBadges(decision).map((badge) => (
                            <code key={badge} style={{ marginRight: 4 }}>
                              {badge}
                            </code>
                          ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td>{stage.kind}</td>
                <td>
                  <strong style={{ color: STATUS_COLORS[stage.status] ?? 'inherit' }}>
                    {stage.status}
                  </strong>
                  {stage.error ? (
                    <div style={{ color: '#cf222e', fontSize: 12 }}>{stage.error}</div>
                  ) : null}
                </td>
                <td>{stage.attempts}</td>
                <td>{duration}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3>Correct this run</h3>
      <form onSubmit={submitCorrection}>
        <label htmlFor="gold">Expected output</label>
        <br />
        <textarea
          id="gold"
          value={gold}
          onChange={(e) => setGold(e.target.value)}
          rows={2}
          cols={40}
          required
        />
        <br />
        <label htmlFor="reason">Why?</label>
        <br />
        <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} size={40} />
        <br />
        <button type="submit">Save correction</button>
      </form>
      {saved && <p role="status">{saved}</p>}

      <h3>Decision records</h3>
      {decisions.length === 0 && <p>No decision records for this run.</p>}
      <ol>
        {decisions.map((decision) => (
          <li key={decision.id} style={{ marginBottom: 12 }}>
            <div>
              {decisionBadges(decision).map((badge) => (
                <code key={badge} style={{ marginRight: 6 }}>
                  {badge}
                </code>
              ))}
              <span style={{ fontSize: 12, color: '#57606a' }}>
                {decision.moduleId}@{decision.moduleVersion} · stage run {decision.stageRunId}
              </span>
            </div>
            {decision.deterministic && <pre>{JSON.stringify(decision.deterministic, null, 2)}</pre>}
            {decision.fallback ? (
              <pre>fallback: {JSON.stringify(decision.fallback, null, 2)}</pre>
            ) : null}
            {decision.error ? (
              <pre style={{ color: '#cf222e' }}>
                error: {JSON.stringify(decision.error, null, 2)}
              </pre>
            ) : null}
            {decision.timings ? (
              <pre>timings: {JSON.stringify(decision.timings, null, 2)}</pre>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
