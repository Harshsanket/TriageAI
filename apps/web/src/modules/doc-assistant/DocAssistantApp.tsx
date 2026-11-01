import { useState } from 'react';
import { apiFetch, type ApiFailure } from '../../host/api';
import { Button, Card, ErrorNotice, Field, Input, Notice, Page } from '../../ui';

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
  const [error, setError] = useState<ApiFailure | null>(null);

  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    const res = await apiFetch<AskResult>('/api/v1/doc-assistant/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) setError(res.error);
    else {
      setError(null);
      setResult(res.data);
    }
  };

  const reingest = async () => {
    setStatus('Ingesting docs…');
    const res = await apiFetch<{ documents: number; chunks: number }>(
      '/api/v1/doc-assistant/reingest',
      { method: 'POST' },
    );
    if (!res.ok) {
      setStatus(null);
      setError(res.error);
      return;
    }
    setError(null);
    setStatus(`Indexed ${res.data.documents} documents (${res.data.chunks} chunks).`);
  };

  return (
    <Page
      title="Doc assistant"
      subtitle={
        <>
          Answers only from this repository’s <code>docs/</code>, citing file paths, or refuses.
        </>
      }
      actions={
        <Button type="button" onClick={() => void reingest()}>
          Re-ingest docs
        </Button>
      }
    >
      <ErrorNotice error={error} onRetry={() => void reingest()} />
      {status && <Notice tone="info">{status}</Notice>}

      <Card title="Ask the docs">
        <form className="ui-form" onSubmit={ask}>
          <Field label="Question">
            <Input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              aria-label="doc question"
              placeholder="e.g. why postgres?"
              size={50}
              required
            />
          </Field>
          <Button type="submit" variant="primary">
            Ask
          </Button>
        </form>
      </Card>

      {result && (
        <Card title={result.refused ? 'Refused' : 'Answer'}>
          <p className="ui-chat__body">{result.answer}</p>
          {result.citations.length > 0 && (
            <p className="ui-citations">
              sources: {result.citations.map((citation) => `[${citation}]`).join(' ')}
              {result.citationSource === 'deterministic' ? ' (citation attached by validator)' : ''}
            </p>
          )}
        </Card>
      )}
    </Page>
  );
}
