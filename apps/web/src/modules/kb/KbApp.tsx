import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../../host/api';

interface DocumentRow {
  id: string;
  title: string;
  source: string;
  approved: boolean;
  version: number;
  updatedAt: string;
}

interface SearchResult {
  chunks: Array<{ id: string; text: string; score: number; metadata: { title?: string } }>;
  gate: { sufficient: boolean; topScore: number };
}

export default function KbApp() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch('/api/v1/kb/documents');
    if (res.ok) setDocuments((await res.json()) as DocumentRow[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const res = await apiFetch('/api/v1/kb/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, source: 'ui' }),
    });
    if (!res.ok) setError(`create failed (${res.status})`);
    else {
      setTitle('');
      setBody('');
    }
    await load();
  };

  const approve = async (id: string) => {
    const res = await apiFetch(`/api/v1/kb/documents/${id}/approve`, { method: 'POST' });
    if (!res.ok) setError(`approve failed (${res.status})`);
    await load();
  };

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    const res = await apiFetch('/api/v1/kb/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (res.ok) setResult((await res.json()) as SearchResult);
  };

  return (
    <section>
      <h2>Knowledge base</h2>
      {error && <p role="alert">{error}</p>}

      <form onSubmit={create} style={{ marginBottom: 16 }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          aria-label="document title"
          required
        />{' '}
        <input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Content"
          aria-label="document body"
          size={50}
          required
        />{' '}
        <button type="submit">Add draft</button>
      </form>

      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th align="left">Title</th>
            <th align="left">Version</th>
            <th align="left">Approved</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.id} style={{ borderTop: '1px solid #ddd' }}>
              <td>{document.title}</td>
              <td>{document.version}</td>
              <td>{document.approved ? 'yes' : 'no'}</td>
              <td>
                {!document.approved && (
                  <button type="button" onClick={() => void approve(document.id)}>
                    Approve
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Search (approved only)</h3>
      <form onSubmit={search}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="kb query"
          size={40}
        />{' '}
        <button type="submit">Search</button>
      </form>
      {result && (
        <div>
          <p>
            sufficient: <strong>{String(result.gate.sufficient)}</strong> · top score{' '}
            {result.gate.topScore.toFixed(3)}
          </p>
          <ol>
            {result.chunks.map((chunk) => (
              <li key={chunk.id}>
                <strong>{chunk.metadata.title ?? 'untitled'}</strong> ({chunk.score.toFixed(3)}):{' '}
                {chunk.text}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
