import { useCallback, useEffect, useState } from 'react';

import type { ApiFailure } from '../host/api';
import { apiFetch } from '../host/api';
import { Button, Card, EmptyState, ErrorNotice, Field, Input, Loading, Page } from '../ui';

interface ApprovalItem {
  id: string;
  runId: string;
  stepId: string;
  toolName: string;
  input: unknown;
  preview: unknown;
  status: string;
  onExpiry: string;
  expiresAt: string;
  createdAt: string;
}

interface ApprovalBatch {
  runId: string;
  toolName: string;
  count: number;
  summary: string;
  items: ApprovalItem[];
  expiresAt: string;
  onExpiry: string;
}

function previewSummary(preview: unknown): string {
  if (typeof preview === 'object' && preview !== null && 'summary' in preview) {
    const summary = (preview as { summary?: unknown }).summary;
    if (typeof summary === 'string') return summary;
  }
  return '';
}

function policyReason(preview: unknown): string | null {
  if (typeof preview !== 'object' || preview === null || !('policy' in preview)) return null;
  const policy = (preview as { policy?: { reason?: unknown } }).policy;
  return typeof policy?.reason === 'string' ? policy.reason : null;
}

function inputPreview(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * `/approvals` (15.T3/T9): pending calls grouped by run + tool, one decision
 * for the batch, itemised rows. Each item is still decided and audited alone.
 */
export default function ApprovalsPage() {
  const [batches, setBatches] = useState<ApprovalBatch[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiFailure | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch<{ batches: ApprovalBatch[] }>('/api/v1/approvals?grouped=1');
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    setBatches(res.data.batches);
    setSelected((current) => {
      const live = new Set(res.data.batches.flatMap((batch) => batch.items.map((item) => item.id)));
      return new Set([...current].filter((id) => live.has(id)));
    });
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleBatch = (batch: ApprovalBatch) => {
    const all = batch.items.every((item) => selected.has(item.id));
    setSelected((current) => {
      const next = new Set(current);
      for (const item of batch.items) {
        if (all) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });
  };

  const decide = async (outcome: 'approve' | 'reject') => {
    if (selected.size === 0) return;
    if (outcome === 'reject' && !reason.trim()) {
      setNote('A rejection reason is required.');
      return;
    }
    setBusy(true);
    setNote(null);
    const res = await apiFetch<{ approvals: ApprovalItem[] }>('/api/v1/approvals/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ids: [...selected],
        outcome,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setNote(res.error.envelope.userMessage);
      return;
    }
    setNote(
      outcome === 'approve'
        ? `Approved ${res.data.approvals.length} call${res.data.approvals.length === 1 ? '' : 's'}.`
        : `Rejected ${res.data.approvals.length} call${res.data.approvals.length === 1 ? '' : 's'}.`,
    );
    setReason('');
    setSelected(new Set());
    await load();
  };

  return (
    <Page
      title="Approvals"
      subtitle="Calls parked for a human. Approve all, a subset, or reject with a reason that goes back to the run."
    >
      <ErrorNotice error={error} onRetry={() => void load()} />
      {note ? <p role="status">{note}</p> : null}
      <Card title="Pending decisions">
        <div className="cfg-inline">
          <Field label="Reason (required to reject)">
            <Input
              aria-label="Reason"
              value={reason}
              placeholder="Why these calls should run or not"
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Button
            variant="primary"
            disabled={busy || selected.size === 0}
            onClick={() => void decide('approve')}
          >
            Approve selected
          </Button>
          <Button
            variant="danger"
            disabled={busy || selected.size === 0}
            onClick={() => void decide('reject')}
          >
            Reject selected
          </Button>
        </div>
        {batches === null ? (
          <Loading>Loading approvals…</Loading>
        ) : batches.length === 0 ? (
          <EmptyState>Nothing is waiting for a decision.</EmptyState>
        ) : (
          batches.map((batch) => (
            <section key={`${batch.runId}:${batch.toolName}`} className="cfg-card">
              <header className="cfg-inline">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Select all ${batch.toolName}`}
                    checked={
                      batch.items.length > 0 && batch.items.every((item) => selected.has(item.id))
                    }
                    onChange={() => toggleBatch(batch)}
                  />
                  <strong>
                    {batch.summary} · {batch.count} item{batch.count === 1 ? '' : 's'}
                  </strong>
                </label>
                <span className="cfg-hint">
                  run {batch.runId} · expires {new Date(batch.expiresAt).toLocaleString()} · on
                  expiry {batch.onExpiry}
                </span>
              </header>
              <ul className="cfg-list">
                {batch.items.map((item) => (
                  <li key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.id}`}
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                      />
                      <strong> {item.toolName}</strong> ·{' '}
                      {previewSummary(item.preview) || item.stepId}
                      {policyReason(item.preview) ? (
                        <div className="cfg-hint">policy: {policyReason(item.preview)}</div>
                      ) : null}
                      <div className="cfg-hint">{inputPreview(item.input)}</div>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </Card>
    </Page>
  );
}
