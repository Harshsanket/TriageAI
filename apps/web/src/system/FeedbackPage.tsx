import { useCallback, useEffect, useState } from 'react';

interface Candidate {
  id: string;
  source: string;
  status: string;
  input: unknown;
  gold: unknown;
  provenance: Record<string, unknown>;
  createdAt: string;
}

interface Dataset {
  id: string;
  version: string;
  purpose: string;
  sha256: string;
  counts: { train: number; val: number; test: number };
  createdAt: string;
}

interface Model {
  id: string;
  component: string;
  name: string;
  status: string;
  evalReportId: string | null;
  evalReport: { passes: boolean; metrics: Record<string, number | null> } | null;
}

interface AuditEntry {
  id: string;
  actor: string | null;
  action: string;
  subject: string | null;
  createdAt: string;
}

const json = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
};

export default function FeedbackPage() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [actor, setActor] = useState('admin');
  const [methods, setMethods] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [candidateRes, datasetRes, modelRes, auditRes] = await Promise.all([
      fetch('/api/v1/system/candidates?limit=50'),
      fetch('/api/v1/datasets?limit=20'),
      fetch('/api/v1/models?limit=50'),
      fetch('/api/v1/system/audit?limit=10'),
    ]);
    if (candidateRes.ok) setCandidates((await candidateRes.json()) as Candidate[]);
    if (datasetRes.ok) setDatasets((await datasetRes.json()) as Dataset[]);
    if (modelRes.ok) setModels((await modelRes.json()) as Model[]);
    if (auditRes.ok) setAudit((await auditRes.json()) as AuditEntry[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const review = async (id: string, status: 'approved' | 'rejected', method: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/system/candidates/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, actor, method }),
      });
      if (!res.ok) throw new Error(`review failed (${res.status})`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const buildDataset = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/v1/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ purpose: 'classifier', createdBy: actor }),
      });
      if (!res.ok) throw new Error(`dataset build failed (${res.status})`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const promote = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/models/${id}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor }),
      });
      if (!res.ok) throw new Error(`promotion blocked (${res.status})`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/models/${id}/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor, reason: 'ui rollback' }),
      });
      if (!res.ok) throw new Error(`rollback failed (${res.status})`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const proposed = candidates.filter((candidate) => candidate.status === 'proposed');

  return (
    <section>
      <h2>Feedback loop</h2>
      <p>
        <label>
          Reviewer{' '}
          <input
            value={actor}
            onChange={(event) => setActor(event.target.value)}
            aria-label="reviewer actor"
          />
        </label>{' '}
        <button type="button" disabled={busy} onClick={() => void buildDataset()}>
          Build dataset from approved
        </button>
      </p>
      {error && <p role="alert">{error}</p>}

      <h3>Review queue ({proposed.length})</h3>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Source</th>
            <th align="left">Input</th>
            <th align="left">Gold</th>
            <th align="left">Method</th>
            <th align="left">Decision</th>
          </tr>
        </thead>
        <tbody>
          {proposed.map((candidate) => (
            <tr key={candidate.id} style={{ borderTop: '1px solid #ddd' }}>
              <td>{candidate.source}</td>
              <td>
                <code>{json(candidate.input)}</code>
              </td>
              <td>
                <code>{json(candidate.gold)}</code>
              </td>
              <td>
                <select
                  value={methods[candidate.id] ?? 'mistake'}
                  aria-label={`method ${candidate.id}`}
                  onChange={(event) =>
                    setMethods((current) => ({ ...current, [candidate.id]: event.target.value }))
                  }
                >
                  <option value="mistake">mistake</option>
                  <option value="better_answer">better answer</option>
                  <option value="denied_outcome">denied outcome</option>
                </select>
              </td>
              <td>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void review(candidate.id, 'approved', methods[candidate.id] ?? 'mistake')
                  }
                >
                  Approve
                </button>{' '}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void review(candidate.id, 'rejected', methods[candidate.id] ?? 'mistake')
                  }
                >
                  Reject
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Datasets</h3>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Version</th>
            <th align="left">Purpose</th>
            <th align="left">train / val / test</th>
            <th align="left">sha256</th>
          </tr>
        </thead>
        <tbody>
          {datasets.map((dataset) => (
            <tr key={dataset.id} style={{ borderTop: '1px solid #ddd' }}>
              <td>{dataset.version}</td>
              <td>{dataset.purpose}</td>
              <td>
                {dataset.counts.train} / {dataset.counts.val} / {dataset.counts.test}
              </td>
              <td>
                <code>{dataset.sha256.slice(0, 12)}…</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Model registry</h3>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Component</th>
            <th align="left">Name</th>
            <th align="left">Status</th>
            <th align="left">Eval</th>
            <th align="left">Action</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => (
            <tr key={model.id} style={{ borderTop: '1px solid #ddd' }}>
              <td>{model.component}</td>
              <td>{model.name}</td>
              <td>{model.status}</td>
              <td>
                {model.evalReport
                  ? `${model.evalReport.passes ? 'pass' : 'fail'} · F1 ${model.evalReport.metrics.macroF1 ?? '—'}`
                  : '—'}
              </td>
              <td>
                {model.status === 'active' ? (
                  <span>active</span>
                ) : model.status === 'rolled_back' ? (
                  <button type="button" disabled={busy} onClick={() => void rollback(model.id)}>
                    Roll back
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void promote(model.id)}>
                    Promote
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Recent audit</h3>
      <ul>
        {audit.map((entry) => (
          <li key={entry.id}>
            {new Date(entry.createdAt).toLocaleString()} · {entry.action} ·{' '}
            {entry.actor ?? 'system'} · {entry.subject ?? '—'}
          </li>
        ))}
      </ul>
    </section>
  );
}
