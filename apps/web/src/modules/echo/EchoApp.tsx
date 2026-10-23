import { useEffect, useState } from 'react';
import type { RunDto } from '@triageai/contracts';

export default function EchoApp() {
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [text, setText] = useState('ship it');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const res = await fetch('/api/v1/echo/runs?limit=10');
      if (!res.ok) return;
      const data = (await res.json()) as RunDto[];
      if (!disposed) setRuns(data);
    };
    void load();
    const timer = setInterval(load, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await fetch('/api/v1/echo/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h2>Echo</h2>
      <form onSubmit={run}>
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label="echo text" />
        <button type="submit" disabled={busy}>
          Run
        </button>
      </form>
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{run.id}</td>
              <td>{run.status}</td>
              <td>{run.createdAt}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
