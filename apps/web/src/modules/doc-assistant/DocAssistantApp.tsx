import { useState } from 'react';
import { apiFetch } from '../../host/api';

interface AskResult {
  answer: string;
  refused: boolean;
  citations: string[];
  citationSource?: string;
  gate?: { sufficient: boolean; topScore: number };
}

export default function DocAssistantApp() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const res = await apiFetch('/api/v1/doc-assistant/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) setError(`ask failed (${res.status})`);
    else setResult((await res.json()) as AskResult);
  };

  const reingest = async () => {
    setError(null);
    setStatus('Ingesting docs…');
    const res = await apiFetch('/api/v1/doc-assistant/reingest', { method: 'POST' });
    if (!res.ok) {
      setStatus(null);
      setError(`reingest failed (${res.status})`);
      return;
    }
    const body = (await res.json()) as { documents: number; chunks: number };
    setStatus(`Indexed ${body.documents} documents (${body.chunks} chunks).`);
  };

  return (
    <section>
      <h2>Doc assistant</h2>
      <p style={{ fontSize: 13, color: '#57606a' }}>
        Answers only from this repository’s <code>docs/</code>, citing file paths, or refuses.
      </p>
      <button type="button" onClick={() => void reingest()}>
        Re-ingest docs
      </button>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}

      <form onSubmit={ask} style={{ marginTop: 12 }}>
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          aria-label="doc question"
          placeholder="e.g. why postgres?"
          size={50}
          required
        />{' '}
        <button type="submit">Ask</button>
      </form>

      {result && (
        <article style={{ marginTop: 12, padding: 8, borderLeft: '3px solid #1a7f37' }}>
          <p style={{ whiteSpace: 'pre-wrap' }}>{result.answer}</p>
          {result.citations.length > 0 && (
            <p style={{ fontSize: 12, color: '#57606a' }}>
              sources: {result.citations.map((citation) => `[${citation}]`).join(' ')}
              {result.citationSource === 'deterministic' ? ' (citation attached by validator)' : ''}
            </p>
          )}
        </article>
      )}
    </section>
  );
}
