/**
 * Knowledge base page (Phase 20.2/20.4): one search bar, a source list with
 * labels and On/Off switches, an "Add knowledge" picker for every source type,
 * approval and retrieval search. Sources come from the server; a failed request
 * is never rendered as an empty list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  KbSearchResponseSchema,
  KbSourceDtoSchema,
  KbStorageStatsSchema,
  type KbSearchResponse,
  type KbSourceDto,
  type KbStorageStats,
} from '@triageai/contracts';

import { apiFetch, type ApiFailure } from '../../host/api';
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Input,
  Page,
  Table,
  Textarea,
} from '../../ui';

const SOURCE_KINDS = [
  { kind: 'note', label: 'Note', hint: 'Type or paste text' },
  { kind: 'file', label: 'File', hint: 'PDF, DOCX, XLSX, CSV, MD, TXT, HTML' },
  { kind: 'url', label: 'Website', hint: 'A single page URL' },
  { kind: 'github', label: 'GitHub', hint: 'Public (or token) repository' },
] as const;

type PickerKind = (typeof SOURCE_KINDS)[number]['kind'];

interface PickerState {
  kind: PickerKind;
  title: string;
  body: string;
  url: string;
  repo: string;
  ref: string;
  token: string;
  label: string;
  files: Array<{ name: string; mediaType: string; base64: string }>;
}

const EMPTY_PICKER: PickerState = {
  kind: 'note',
  title: '',
  body: '',
  url: '',
  repo: '',
  ref: '',
  token: '',
  label: '',
  files: [],
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export default function KbApp() {
  const [sources, setSources] = useState<KbSourceDto[]>([]);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [result, setResult] = useState<KbSearchResponse | null>(null);
  const [error, setError] = useState<string | Error | ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [storage, setStorage] = useState<KbStorageStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (kindFilter) params.set('kind', kindFilter);
    if (labelFilter) params.set('label', labelFilter);
    const [sourceRes, storageRes] = await Promise.all([
      apiFetch<unknown>(`/api/v1/kb/sources${params.toString() ? `?${params}` : ''}`),
      apiFetch<unknown>('/api/v1/kb/storage'),
    ]);
    if (!sourceRes.ok) {
      setError(sourceRes.error);
      return;
    }
    const parsedSources = KbSourceDtoSchema.array().safeParse(
      (sourceRes.data as { sources?: unknown }).sources,
    );
    const parsedStorage = storageRes.ok ? KbStorageStatsSchema.safeParse(storageRes.data) : null;
    if (!parsedSources.success) {
      setError('The knowledge API returned an unexpected shape.');
      return;
    }
    setError(null);
    setSources(parsedSources.data);
    if (parsedStorage?.success) setStorage(parsedStorage.data);
  }, [query, kindFilter, labelFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const labels = useMemo(
    () => [...new Set(sources.map((source) => source.label))].sort(),
    [sources],
  );

  const toggleSource = async (source: KbSourceDto) => {
    const res = await apiFetch(`/api/v1/kb/sources/${source.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !source.enabled }),
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(`${source.title} is now ${source.enabled ? 'off' : 'on'}.`);
    await load();
  };

  const refreshBaseMemory = async () => {
    setRefreshing(true);
    const res = await apiFetch('/api/v1/system/base-memory/refresh', { method: 'POST' });
    setRefreshing(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice('Base memory refreshed.');
    await load();
  };

  const removeSource = async (source: KbSourceDto) => {
    if (!globalThis.confirm?.(`Delete “${source.title}” and its chunks?`)) return;
    const res = await apiFetch(`/api/v1/kb/sources/${source.id}`, { method: 'DELETE' });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(`${source.title} deleted.`);
    await load();
  };

  const search = async () => {
    if (!query.trim()) return;
    const res = await apiFetch<unknown>('/api/v1/kb/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: query.trim() }),
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const parsed = KbSearchResponseSchema.safeParse(res.data);
    if (parsed.success) setResult(parsed.data);
    else setError('The search API returned an unexpected shape.');
  };

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    const next: PickerState['files'] = [];
    for (const file of [...files]) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      next.push({
        name: file.name,
        mediaType: file.type || mediaTypeForName(file.name),
        base64: bytesToBase64(bytes),
      });
    }
    setPicker((current) => (current ? { ...current, files: next } : current));
  };

  const submitPicker = async () => {
    if (!picker) return;
    setBusy(true);
    try {
      if (picker.kind === 'file') {
        const items = picker.files.map((file) => ({
          kind: 'file',
          title: file.name,
          label: picker.label || 'Document',
          contentBase64: file.base64,
          mediaType: file.mediaType,
        }));
        if (items.length === 0) {
          setError('Choose at least one file.');
          return;
        }
        const res = await apiFetch('/api/v1/kb/sources/batch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items, collectionTitle: 'knowledge base' }),
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setNotice(`Imported ${items.length} file${items.length === 1 ? '' : 's'}.`);
      } else {
        const payload =
          picker.kind === 'note'
            ? { kind: 'note', title: picker.title || 'Note', body: picker.body }
            : picker.kind === 'url'
              ? { kind: 'url', title: picker.title || picker.url, url: picker.url }
              : {
                  kind: 'github',
                  title: picker.title || picker.repo,
                  repo: picker.repo,
                  ...(picker.ref ? { ref: picker.ref } : {}),
                  ...(picker.token ? { token: picker.token } : {}),
                };
        const res = await apiFetch('/api/v1/kb/sources', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            ...(picker.label ? { label: picker.label } : {}),
          }),
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setNotice('Knowledge added.');
      }
      setPicker(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Knowledge base"
      subtitle="Every enabled source is searchable as soon as ingestion finishes."
      actions={
        <Button variant="primary" onClick={() => setPicker({ ...EMPTY_PICKER })}>
          Add knowledge
        </Button>
      }
    >
      {error ? <ErrorNotice error={error} onRetry={() => void load()} /> : null}
      {notice ? (
        <p className="kb-notice" role="status">
          {notice}
        </p>
      ) : null}

      <Card title="Storage">
        {storage ? (
          <dl className="kb-storage" aria-label="Knowledge storage">
            <div>
              <dt>Total</dt>
              <dd>{formatBytes(storage.totalBytes)}</dd>
            </div>
            <div>
              <dt>Original files</dt>
              <dd>{formatBytes(storage.originalsBytes)}</dd>
            </div>
            <div>
              <dt>Extracted text</dt>
              <dd>{formatBytes(storage.textBytes)}</dd>
            </div>
            <div>
              <dt>Chunks + vectors</dt>
              <dd>{formatBytes(storage.chunksBytes + storage.vectorBytes)}</dd>
            </div>
            <div>
              <dt>Documents / chunks</dt>
              <dd>
                {storage.documents} / {storage.chunks}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="kb-muted">Storage totals are unavailable.</p>
        )}
      </Card>

      <Card title="Search">
        <div className="kb-search">
          <Input
            aria-label="Search knowledge"
            placeholder="Search sources by name, type or label, then press Enter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void search();
            }}
          />
          <Button onClick={() => void search()}>Search chunks</Button>
          <select
            aria-label="Source type filter"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value)}
          >
            <option value="">All types</option>
            {SOURCE_KINDS.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Source label filter"
            value={labelFilter}
            onChange={(event) => setLabelFilter(event.target.value)}
          >
            <option value="">All labels</option>
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {result && (
          <div className="kb-results">
            <p className="kb-muted">
              {result.chunks.length === 0
                ? 'No chunks matched.'
                : `${result.chunks.length} chunk(s) matched; gate ${result.gate.sufficient ? 'sufficient' : 'insufficient'}.`}
            </p>
            <ul>
              {result.chunks.map((chunk) => (
                <li key={chunk.id}>
                  <strong>{String(chunk.metadata.title ?? chunk.documentId)}</strong> ·{' '}
                  {chunk.score.toFixed(2)}
                  <p>{chunk.text}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card
        title="Sources"
        actions={
          <div className="kb-card-actions">
            <Button onClick={() => void refreshBaseMemory()} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh base memory'}
            </Button>
            <Button onClick={() => void load()}>Refresh</Button>
          </div>
        }
      >
        {sources.length === 0 && !error ? (
          <EmptyState>No sources yet. Use “Add knowledge” to start.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Uploaded</th>
                <th>Items</th>
                <th>Size</th>
                <th>Status</th>
                <th>Use</th>
                <th className="kb-delete-cell">Delete</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => (
                <tr key={source.id}>
                  <td>
                    <strong>{source.title}</strong>
                    <div className="kb-muted">
                      {source.kind}
                      {source.managedKey ? (
                        <span
                          className="kb-badge"
                          title="Generated from setup and refreshed by the host"
                        >
                          Managed
                        </span>
                      ) : null}
                      {source.readOnly ? <span className="kb-badge">Read-only</span> : null}
                      {source.audience === 'operator' ? (
                        <span className="kb-badge">Operator</span>
                      ) : null}
                    </div>
                  </td>
                  <td>{new Date(source.createdAt).toLocaleDateString('en-GB')}</td>
                  <td>{source.itemCount}</td>
                  <td>{formatBytes(source.sizeBytes)}</td>
                  <td>
                    <span className={`kb-status kb-status--${source.status}`}>{source.status}</span>
                  </td>
                  <td className="kb-actions-cell">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={source.enabled}
                      aria-label={`${source.title} enabled`}
                      className={`kb-switch${source.enabled ? ' kb-switch--on' : ''}`}
                      onClick={() => void toggleSource(source)}
                    >
                      <span />
                    </button>
                  </td>
                  <td className="kb-delete-cell">
                    {source.managedKey || source.readOnly ? (
                      <span className="kb-muted" title="Managed sources cannot be deleted here">
                        —
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="kb-delete"
                        aria-label={`Delete ${source.title}`}
                        title="Delete this source and its chunks"
                        onClick={() => void removeSource(source)}
                      >
                        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                          <path
                            d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v4M11 9v4"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                          />
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {picker ? (
        <div className="kb-picker" role="dialog" aria-label="Add knowledge">
          <div className="kb-picker__panel">
            <div className="kb-picker__head">
              <h2>Add knowledge</h2>
              <button type="button" aria-label="Close" onClick={() => setPicker(null)}>
                ×
              </button>
            </div>
            <div className="kb-picker__kinds" role="tablist" aria-label="Source type">
              {SOURCE_KINDS.map((entry) => (
                <button
                  key={entry.kind}
                  type="button"
                  role="tab"
                  aria-selected={picker.kind === entry.kind}
                  className={picker.kind === entry.kind ? 'kb-picker__kind--active' : undefined}
                  onClick={() =>
                    setPicker((current) => (current ? { ...current, kind: entry.kind } : current))
                  }
                >
                  {entry.label}
                  <small>{entry.hint}</small>
                </button>
              ))}
            </div>
            {picker.kind !== 'file' && (
              <Field label="Title">
                <Input
                  value={picker.title}
                  onChange={(event) =>
                    setPicker((current) =>
                      current ? { ...current, title: event.target.value } : current,
                    )
                  }
                />
              </Field>
            )}
            {picker.kind === 'note' && (
              <Field label="Text">
                <Textarea
                  rows={8}
                  value={picker.body}
                  onChange={(event) =>
                    setPicker((current) =>
                      current ? { ...current, body: event.target.value } : current,
                    )
                  }
                />
              </Field>
            )}
            {picker.kind === 'file' && (
              <Field label="Files">
                <input
                  type="file"
                  multiple
                  accept=".pdf,.docx,.xlsx,.csv,.tsv,.md,.txt,.html,.json"
                  onChange={(event) => void addFiles(event.target.files)}
                />
              </Field>
            )}
            {picker.kind === 'url' && (
              <Field label="URL">
                <Input
                  type="url"
                  value={picker.url}
                  onChange={(event) =>
                    setPicker((current) =>
                      current ? { ...current, url: event.target.value } : current,
                    )
                  }
                />
              </Field>
            )}
            {picker.kind === 'github' && (
              <>
                <Field label="Repository (owner/name)">
                  <Input
                    value={picker.repo}
                    onChange={(event) =>
                      setPicker((current) =>
                        current ? { ...current, repo: event.target.value } : current,
                      )
                    }
                  />
                </Field>
                <Field label="Ref (optional)">
                  <Input
                    value={picker.ref}
                    onChange={(event) =>
                      setPicker((current) =>
                        current ? { ...current, ref: event.target.value } : current,
                      )
                    }
                  />
                </Field>
                <Field label="Token (optional, never stored in the overlay)">
                  <Input
                    type="password"
                    value={picker.token}
                    onChange={(event) =>
                      setPicker((current) =>
                        current ? { ...current, token: event.target.value } : current,
                      )
                    }
                  />
                </Field>
              </>
            )}
            <Field label="Label">
              <Input
                placeholder="Document, Note, Website…"
                value={picker.label}
                onChange={(event) =>
                  setPicker((current) =>
                    current ? { ...current, label: event.target.value } : current,
                  )
                }
              />
            </Field>
            <div className="kb-picker__actions">
              <Button onClick={() => setPicker(null)}>Cancel</Button>
              <Button variant="primary" disabled={busy} onClick={() => void submitPicker()}>
                {busy ? 'Importing…' : 'Add'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Page>
  );
}

function mediaTypeForName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (
    {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv',
      tsv: 'text/tab-separated-values',
      md: 'text/markdown',
      txt: 'text/plain',
      html: 'text/html',
      json: 'application/json',
    }[ext] ?? 'application/octet-stream'
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
