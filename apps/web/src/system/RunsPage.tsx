import { useCallback, useEffect, useState } from 'react';
import type { RunDailySummary, RunDto } from '@triageai/contracts';

import { apiFetch, type ApiFailure } from '../host/api';
import { navigate } from '../host/router';
import { Button, Card, EmptyState, ErrorNotice, Loading, Page, StatusText, Table } from '../ui';

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
  const [daily, setDaily] = useState<RunDailySummary | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch<RunDto[]>('/api/v1/system/runs?limit=50');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setRuns(res.data);
  }, []);

  const loadDaily = useCallback(async () => {
    const res = await apiFetch<RunDailySummary>('/api/v1/system/runs/daily?days=14');
    if (res.ok && Array.isArray(res.data?.days)) setDaily(res.data);
  }, []);

  useEffect(() => {
    void load();
    void loadDaily();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load, loadDaily]);

  return (
    <Page title="Runs" subtitle="Every workflow run, its stages and its decision records.">
      <ErrorNotice error={error} onRetry={() => void load()} />
      <Card title="Daily summary">
        {daily === null ? (
          <Loading>Loading daily summary…</Loading>
        ) : daily.days.length === 0 ? (
          <EmptyState>No runs in the last 14 days.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Runs</th>
                <th>Workflows</th>
                <th>Succeeded</th>
                <th>Failed</th>
                <th>Sensitive data</th>
                <th>Touched data</th>
              </tr>
            </thead>
            <tbody>
              {daily.days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{day.totalRuns}</td>
                  <td>{day.workflows.join(', ') || '—'}</td>
                  <td>{day.succeeded}</td>
                  <td>{day.failed}</td>
                  <td>{day.sensitiveRuns}</td>
                  <td>{day.dataTouchedRuns}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Recent runs">
        {runs === null && !error ? (
          <Loading>Loading runs…</Loading>
        ) : runs && runs.length === 0 ? (
          <EmptyState>No runs yet — trigger a workflow to see it here.</EmptyState>
        ) : runs ? (
          <Table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Workflow</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => navigate(`/runs/${run.id}`)}
                    >
                      {run.id}
                    </Button>
                  </td>
                  <td>{run.workflowId}</td>
                  <td>
                    <StatusText
                      status={run.status}
                      color={STATUS_COLORS[run.status] ?? 'inherit'}
                    />
                  </td>
                  <td>{run.createdAt}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : null}
      </Card>
    </Page>
  );
}
