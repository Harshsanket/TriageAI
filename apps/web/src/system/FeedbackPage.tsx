/**
 * Feedback insights (Phase 23.5): where each item came from, what it said and
 * how it was processed — plus volume, sentiment, reasons and the funnel.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { FeedbackInsights, FeedbackInsightItem } from '@triageai/contracts';
import { FeedbackInsightsSchema } from '@triageai/contracts';

import { apiFetch, type ApiFailure } from '../host/api';

const STEP_LABEL: Record<FeedbackInsightItem['timeline'][number]['step'], string> = {
  received: 'Received',
  triaged: 'Triaged',
  reviewed: 'Reviewed',
  added_to_dataset: 'Added to dataset',
  used_in_eval: 'Used in eval',
  outcome: 'Outcome',
};

function Bars({
  label,
  points,
}: {
  label: string;
  points: Array<{ label: string; values: Record<string, number> }>;
}) {
  const max = Math.max(
    1,
    ...points.map((point) => Object.values(point.values).reduce((s, v) => s + v, 0)),
  );
  return (
    <figure className="dashboard__chart" aria-label={label}>
      <figcaption className="visually-hidden">{label}</figcaption>
      {points.length === 0 ? (
        <p className="dashboard__empty">No data yet.</p>
      ) : (
        <ul>
          {points.slice(-14).map((point) => {
            const total = Object.values(point.values).reduce((sum, value) => sum + value, 0);
            return (
              <li key={point.label}>
                <span className="dashboard__chart-bar" aria-hidden="true">
                  <span style={{ height: `${Math.max(4, (total / max) * 100)}%` }} />
                </span>
                <span className="dashboard__chart-label">{point.label}</span>
                <span className="dashboard__chart-value">{total}</span>
              </li>
            );
          })}
        </ul>
      )}
    </figure>
  );
}

export default function FeedbackPage() {
  const [insights, setInsights] = useState<FeedbackInsights | null>(null);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<ApiFailure | string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (source) params.set('source', source);
    if (status) params.set('status', status);
    const res = await apiFetch<unknown>(`/api/v1/system/feedback-insights?${params}`);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const parsed = FeedbackInsightsSchema.safeParse(res.data);
    if (parsed.success) {
      setInsights(parsed.data);
      setError(null);
    } else setError('The feedback API returned an unexpected shape.');
  }, [source, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const review = async (item: FeedbackInsightItem, decision: 'approved' | 'rejected') => {
    const res = await apiFetch(`/api/v1/system/candidates/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: decision, actor: 'reviewer', method: 'mistake' }),
    });
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNote(`${item.source} item ${decision}.`);
    await load();
  };

  const sources = useMemo(
    () => [...new Set((insights?.items ?? []).map((item) => item.source))].sort(),
    [insights],
  );

  return (
    <section>
      <header className="dashboard__header">
        <div>
          <h2>Feedback insights</h2>
          <p className="dashboard__subtitle">
            Where it came from, what it said, and what happened to it.
          </p>
        </div>
      </header>
      {error && (
        <p role="alert">{typeof error === 'string' ? error : error.envelope.userMessage}</p>
      )}
      {note ? <p aria-live="polite">{note}</p> : null}
      <div className="dashboard__controls">
        <label>
          Source{' '}
          <select
            aria-label="Feedback source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          >
            <option value="">All sources</option>
            {sources.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status{' '}
          <select
            aria-label="Feedback status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {['proposed', 'approved', 'rejected'].map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
      </div>

      {insights && (
        <>
          <div className="dashboard__grid">
            <article className="dashboard__tile" aria-labelledby="feedback-volume">
              <h3 id="feedback-volume">Volume</h3>
              <Bars
                label="Feedback volume by source"
                points={insights.graphs.volume.map((point) => ({
                  label: point.bucket.slice(5),
                  values: point.bySource,
                }))}
              />
            </article>
            <article className="dashboard__tile" aria-labelledby="feedback-sentiment">
              <h3 id="feedback-sentiment">Positive vs negative</h3>
              <Bars
                label="Feedback sentiment"
                points={insights.graphs.sentiment.map((point) => ({
                  label: point.bucket.slice(5),
                  values: { positive: point.positive, negative: point.negative },
                }))}
              />
            </article>
            <article className="dashboard__tile" aria-labelledby="feedback-reasons">
              <h3 id="feedback-reasons">Top reasons</h3>
              {insights.graphs.topReasons.length === 0 ? (
                <p className="dashboard__empty">No reasons recorded.</p>
              ) : (
                <ul className="dashboard__list">
                  {insights.graphs.topReasons.map((reason) => (
                    <li key={reason.reason}>
                      <span>{reason.reason}</span>
                      <span>{reason.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
            <article className="dashboard__tile" aria-labelledby="feedback-funnel">
              <h3 id="feedback-funnel">Processing funnel</h3>
              <dl className="dashboard__facts">
                <div>
                  <dt>Received</dt>
                  <dd>{insights.graphs.funnel.received}</dd>
                </div>
                <div>
                  <dt>Reviewed</dt>
                  <dd>{insights.graphs.funnel.reviewed}</dd>
                </div>
                <div>
                  <dt>Accepted</dt>
                  <dd>{insights.graphs.funnel.accepted}</dd>
                </div>
                <div>
                  <dt>Used</dt>
                  <dd>{insights.graphs.funnel.used}</dd>
                </div>
                <div>
                  <dt>Avg review time</dt>
                  <dd>
                    {insights.graphs.avgReviewHours == null
                      ? '—'
                      : `${insights.graphs.avgReviewHours} h`}
                  </dd>
                </div>
              </dl>
            </article>
          </div>

          <div className="dashboard__tile dashboard__tile--wide" aria-labelledby="feedback-items">
            <h3 id="feedback-items">Items</h3>
            {insights.items.length === 0 ? (
              <p className="dashboard__empty">No feedback items match.</p>
            ) : (
              <ul className="feedback-items">
                {insights.items.map((item) => (
                  <li key={item.id} className="feedback-item">
                    <header>
                      <strong>{item.source}</strong> · {item.status} · {item.rating}
                      {item.reason ? ` · ${item.reason}` : ''}
                      {item.module ? ` · ${item.module}` : ''}
                      {item.agent ? ` · ${item.agent}` : ''}
                      {item.model ? ` · ${item.model}` : ''}
                    </header>
                    <p>{item.text}</p>
                    {item.answer ? <p className="kb-muted">Answer: {item.answer}</p> : null}
                    {item.citations.length > 0 ? (
                      <p className="kb-muted">Sources: {item.citations.join(', ')}</p>
                    ) : null}
                    <ol className="feedback-timeline" aria-label="Processing timeline">
                      {item.timeline.map((step) => (
                        <li
                          key={step.step}
                          className={`feedback-step feedback-step--${step.status}`}
                        >
                          <strong>{STEP_LABEL[step.step]}</strong> · {step.detail ?? ''} ·{' '}
                          {new Date(step.at).toLocaleString()}
                          {step.href ? <a href={step.href}> open</a> : null}
                        </li>
                      ))}
                    </ol>
                    {item.status === 'proposed' ? (
                      <div className="cfg-actions">
                        <button type="button" onClick={() => void review(item, 'approved')}>
                          Approve
                        </button>
                        <button type="button" onClick={() => void review(item, 'rejected')}>
                          Reject
                        </button>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
