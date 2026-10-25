import { useEffect, useState } from 'react';
import type { RunDto } from '@triageai/contracts';

import { navigate } from '../host/router';
import { apiFetch } from '../host/api';

const STATUS_COLORS: Record<string, string> = {
  SUCCEEDED: '#1a7f37',
  FAILED: '#cf222e',
  CANCELLED: '#9a6700',
  CANCELLED_PENDING: '#9a6700',
  AWAITING: '#8250df',
  RUNNING: '#0969da',
  PENDING: '#57606a',
};

export default function RunsPage() {
  const [runs, setRuns] = useState<RunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const res = await apiFetch('/api/v1/system/runs?limit=50');
        if (!res.ok) throw new Error(`failed to load runs (${res.status})`);
        const data = (await res.json()) as RunDto[];
        if (!disposed) setRuns(data);
      } catch (err) {
        if (!disposed) setError((err as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <section>
      <h2>Runs</h2>
      {error && <p role="alert">{error}</p>}
      {runs === null && !error && <p>Loading runs…</p>}
      {runs && runs.length === 0 && <p>No runs yet — trigger a workflow to see it here.</p>}
      {runs && runs.length > 0 && (
        <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th align="left">Run</th>
              <th align="left">Workflow</th>
              <th align="left">Status</th>
              <th align="left">Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id} style={{ borderTop: '1px solid #ddd' }}>
                <td>
                  <button type="button" onClick={() => navigate(`/runs/${run.id}`)}>
                    {run.id}
                  </button>
                </td>
                <td>{run.workflowId}</td>
                <td>
                  <strong style={{ color: STATUS_COLORS[run.status] ?? 'inherit' }}>
                    {run.status}
                  </strong>
                </td>
                <td>{run.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
