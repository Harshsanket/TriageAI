/**
 * Dataset views (Phase 20.3): auto-built from the extraction profile with
 * charts and a filterable table. Needs-review datasets are visibly excluded
 * from the "ready" charts but remain inspectable.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  DatasetSummarySchema,
  ExtractedDatasetDtoSchema,
  ExtractedRowDtoSchema,
  type DatasetSummary,
  type ExtractedDatasetDto,
  type ExtractedRowDto,
} from '@triageai/contracts';

import { apiFetch, type ApiFailure } from '../../host/api';
import { Button, Card, EmptyState, ErrorNotice, Field, Input, Page, Textarea } from '../../ui';

export default function DataExtractApp() {
  const [datasets, setDatasets] = useState<ExtractedDatasetDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = datasets.find((dataset) => dataset.id === selectedId) ?? null;
  const [summary, setSummary] = useState<DatasetSummary | null>(null);
  const [rows, setRows] = useState<ExtractedRowDto[]>([]);
  const [error, setError] = useState<string | Error | ApiFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [csv, setCsv] = useState('');
  const [opening, setOpening] = useState('');
  const [closing, setClosing] = useState('');
  const [confirmMapping, setConfirmMapping] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch<unknown>('/api/v1/data-extract/datasets');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const parsed = ExtractedDatasetDtoSchema.array().safeParse(res.data);
    if (!parsed.success) {
      setError('The dataset API returned an unexpected shape.');
      return;
    }
    setError(null);
    setDatasets(parsed.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setSummary(null);
      setRows([]);
      return;
    }
    void (async () => {
      const [summaryRes, rowsRes] = await Promise.all([
        apiFetch<unknown>(`/api/v1/data-extract/datasets/${selected.id}/summary`),
        apiFetch<unknown>(`/api/v1/data-extract/datasets/${selected.id}/rows`),
      ]);
      if (!summaryRes.ok) {
        setError(summaryRes.error);
        return;
      }
      const parsedSummary = DatasetSummarySchema.safeParse(summaryRes.data);
      if (parsedSummary.success) setSummary(parsedSummary.data);
      if (rowsRes.ok) {
        const parsedRows = ExtractedRowDtoSchema.array().safeParse(
          (rowsRes.data as { rows?: unknown }).rows,
        );
        if (parsedRows.success) setRows(parsedRows.data);
      }
    })();
  }, [selected]);

  const importCsv = async () => {
    if (!title.trim() || !csv.trim()) return;
    setBusy(true);
    try {
      const res = await apiFetch<unknown>('/api/v1/data-extract/datasets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          content: csv,
          mediaType: 'text/csv',
          confirmMapping,
          pinned: false,
          ...(opening ? { openingBalance: Number(opening) } : {}),
          ...(closing ? { closingBalance: Number(closing) } : {}),
        }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const parsed = ExtractedDatasetDtoSchema.safeParse(
        (res.data as { dataset?: unknown }).dataset,
      );
      setNotice(
        parsed.success
          ? parsed.data.status === 'ready'
            ? 'Dataset imported.'
            : `Dataset imported for review: ${parsed.data.reviewReason ?? 'needs review'}`
          : 'Dataset imported.',
      );
      setTitle('');
      setCsv('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async () => {
    if (!selected) return;
    const res = await apiFetch(`/api/v1/data-extract/datasets/${selected.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: !selected.pinned }),
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await load();
  };

  return (
    <Page
      title="Datasets"
      subtitle="Documents with records become typed, queryable data. Numbers come from SQL, not a model."
    >
      {error ? <ErrorNotice error={error} onRetry={() => void load()} /> : null}
      {notice ? (
        <p className="kb-notice" role="status">
          {notice}
        </p>
      ) : null}

      <Card title="Import a table">
        <div className="dataset-import">
          <Field label="Title">
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="CSV (headers + rows)">
            <Textarea rows={6} value={csv} onChange={(event) => setCsv(event.target.value)} />
          </Field>
          <div className="dataset-import__row">
            <Field label="Opening balance (optional)">
              <Input
                inputMode="decimal"
                value={opening}
                onChange={(event) => setOpening(event.target.value)}
              />
            </Field>
            <Field label="Closing balance (optional)">
              <Input
                inputMode="decimal"
                value={closing}
                onChange={(event) => setClosing(event.target.value)}
              />
            </Field>
            <label className="kb-check">
              <input
                type="checkbox"
                checked={confirmMapping}
                onChange={(event) => setConfirmMapping(event.target.checked)}
              />
              Confirm mapping
            </label>
          </div>
          <Button variant="primary" disabled={busy} onClick={() => void importCsv()}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </Card>

      <div className="dataset-layout">
        <Card title="Your datasets">
          {datasets.length === 0 ? (
            <EmptyState>No datasets yet.</EmptyState>
          ) : (
            <ul className="dataset-list">
              {datasets.map((dataset) => (
                <li key={dataset.id}>
                  <button
                    type="button"
                    className={selected?.id === dataset.id ? 'dataset-list__active' : undefined}
                    onClick={() => setSelectedId(dataset.id)}
                  >
                    <strong>{dataset.title}</strong>
                    <span>{dataset.profile}</span>
                    <span className={`kb-status kb-status--${dataset.status}`}>
                      {dataset.status}
                    </span>
                    <span>{dataset.rowCount} rows</span>
                    {dataset.pinned ? <span aria-label="pinned">★</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={selected ? selected.title : 'Dataset view'}
          actions={
            selected ? (
              <>
                <Button onClick={() => void togglePin()}>
                  {selected.pinned ? 'Unpin' : 'Pin to dashboard'}
                </Button>
              </>
            ) : undefined
          }
        >
          {!selected ? (
            <EmptyState>Select a dataset to see its charts and rows.</EmptyState>
          ) : summary ? (
            <>
              {summary.dataset.status !== 'ready' ? (
                <p className="kb-notice" role="status">
                  Needs review: {summary.dataset.reviewReason ?? 'not ready for charts'}.
                </p>
              ) : (
                <>
                  <dl className="dataset-totals">
                    <div>
                      <dt>In</dt>
                      <dd>{money(summary.totals.in)}</dd>
                    </div>
                    <div>
                      <dt>Out</dt>
                      <dd>{money(summary.totals.out)}</dd>
                    </div>
                    <div>
                      <dt>Net</dt>
                      <dd>{money(summary.totals.net)}</dd>
                    </div>
                    <div>
                      <dt>Rows</dt>
                      <dd>{summary.totals.rows}</dd>
                    </div>
                  </dl>
                  <div className="dataset-charts">
                    <Chart
                      title="Spending by category"
                      data={summary.byCategory.map((row) => ({
                        label: row.category,
                        value: row.total,
                      }))}
                    />
                    <Chart
                      title="By month"
                      data={summary.byMonth.map((row) => ({
                        label: row.month,
                        value: row.total,
                      }))}
                    />
                  </div>
                  {summary.topMerchants.length > 0 ? (
                    <div className="dataset-merchants">
                      <h3>Top merchants</h3>
                      <ul>
                        {summary.topMerchants.map((merchant) => (
                          <li key={merchant.merchant}>
                            <span>{merchant.merchant}</span>
                            <span>{money(merchant.total)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )}
              <div className="dataset-table">
                <h3>Rows</h3>
                <table>
                  <thead>
                    <tr>
                      {Object.keys(rows[0]?.fields ?? {}).map((key) => (
                        <th key={key}>{key}</th>
                      ))}
                      <th>category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 200).map((row) => (
                      <tr key={row.id}>
                        {Object.keys(rows[0]?.fields ?? {}).map((key) => (
                          <td key={key}>{String(row.fields[key] ?? '')}</td>
                        ))}
                        <td>{row.category ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {Object.keys(rows[0]?.fields ?? {}).length === 0 ? (
                  <p className="kb-muted">No rows stored.</p>
                ) : null}
              </div>
            </>
          ) : (
            <p className="kb-muted">Loading dataset…</p>
          )}
        </Card>
      </div>
    </Page>
  );
}

function Chart({ title, data }: { title: string; data: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...data.map((row) => Math.abs(row.value)));
  return (
    <figure className="dataset-chart">
      <figcaption>{title}</figcaption>
      {data.length === 0 ? (
        <p className="kb-muted">No data.</p>
      ) : (
        <ul>
          {data.slice(0, 12).map((row) => (
            <li key={row.label}>
              <span className="dataset-chart__label">{row.label}</span>
              <span className="dataset-chart__bar" aria-hidden="true">
                <span style={{ width: `${Math.max(2, (Math.abs(row.value) / max) * 100)}%` }} />
              </span>
              <span className="dataset-chart__value">{money(row.value)}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

function money(value: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
}
