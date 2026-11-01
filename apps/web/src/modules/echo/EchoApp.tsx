import { useCallback, useEffect, useState } from 'react';
import type { RunDto } from '@triageai/contracts';
import { apiFetch, type ApiFailure } from '../../host/api';
import { Button, Card, ErrorNotice, Field, Input, Page, Table } from '../../ui';

export default function EchoApp() {
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [text, setText] = useState('ship it');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch<RunDto[]>('/api/v1/echo/runs?limit=10');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setRuns(res.data);
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 1000);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await apiFetch('/api/v1/echo/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) setError(res.error);
      else setError(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Echo" subtitle="Reference module: one workflow, one stage, one run.">
      <ErrorNotice error={error} onRetry={() => void load()} />
      <Card title="Run the echo stage">
        <form className="ui-form" onSubmit={run}>
          <Field label="Text">
            <Input value={text} onChange={(e) => setText(e.target.value)} aria-label="echo text" />
          </Field>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Running…' : 'Run'}
          </Button>
        </form>
      </Card>
      <Card title="Recent runs">
        <Table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((row) => (
              <tr key={row.id}>
                <td className="ui-code">{row.id}</td>
                <td>{row.status}</td>
                <td>{row.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </Page>
  );
}
