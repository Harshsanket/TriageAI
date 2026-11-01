/**
 * Notification tray for long-running server jobs (Phase 20.1). State comes from
 * `GET /api/v1/system/jobs`, so a reload or navigation keeps the cards. ETA is
 * derived from observed progress over the last 30 s and clamped so it cannot
 * jump by more than 2×.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { JobsResponseSchema, type JobDto } from '@triageai/contracts';

import { apiFetch } from './api';

const DISMISS_MS = 8_000;
const DISMISSED_KEY = 'triageai.dismissedJobs';
const SAMPLE_WINDOW_MS = 30_000;

interface Sample {
  at: number;
  done: number;
}

function formatEta(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  return `${Math.ceil(minutes / 60)}h left`;
}

export function estimateEta(
  job: JobDto,
  samples: Sample[],
  now: number,
  previous: number | null,
): number | null {
  if (job.total <= 0 || job.done >= job.total) return 0;
  const age = now - Date.parse(job.createdAt);
  const windowed = samples.filter((sample) => now - sample.at <= SAMPLE_WINDOW_MS);
  if (age < 3_000 || windowed.length < 2) return null;
  const first = windowed[0] as Sample;
  const last = windowed[windowed.length - 1] as Sample;
  const span = (last.at - first.at) / 1000;
  const rate = (last.done - first.done) / span;
  if (!Number.isFinite(rate) || rate <= 0) return previous;
  let eta = Math.ceil((job.total - job.done) / rate) * 1000;
  if (previous !== null && previous > 0) {
    eta = Math.min(previous * 2, Math.max(previous / 2, eta));
  }
  return Math.max(0, eta);
}

export function JobsTray({
  pollMs = 2_000,
  onOpen,
}: {
  pollMs?: number;
  onOpen?: (job: JobDto) => void;
}): React.JSX.Element | null {
  const [active, setActive] = useState<JobDto[]>([]);
  const [recent, setRecent] = useState<JobDto[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const samples = useRef(new Map<string, Sample[]>());
  const etas = useRef(new Map<string, number>());
  const dismissed = useRef(
    new Set<string>(
      (() => {
        try {
          const raw = globalThis.localStorage?.getItem(DISMISSED_KEY);
          const parsed = raw ? (JSON.parse(raw) as unknown) : [];
          return Array.isArray(parsed)
            ? parsed.filter((entry): entry is string => typeof entry === 'string')
            : [];
        } catch {
          return [];
        }
      })(),
    ),
  );
  const dismissTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((jobId: string) => {
    dismissed.current.add(jobId);
    try {
      globalThis.localStorage?.setItem(
        DISMISSED_KEY,
        JSON.stringify([...dismissed.current].slice(-500)),
      );
    } catch {
      // Private mode: dismissals last for this tab only.
    }
    const timer = dismissTimers.current.get(jobId);
    if (timer) clearTimeout(timer);
    dismissTimers.current.delete(jobId);
    setActive((items) => items.filter((job) => job.id !== jobId));
    setRecent((items) => items.filter((job) => job.id !== jobId));
  }, []);

  const load = useCallback(async () => {
    const result = await apiFetch<unknown>('/api/v1/system/jobs');
    if (!result.ok) return;
    const parsed = JobsResponseSchema.safeParse(result.data);
    if (!parsed.success) return;
    const now = Date.now();
    for (const job of [...parsed.data.active, ...parsed.data.recent]) {
      const list = samples.current.get(job.id) ?? [];
      list.push({ at: now, done: job.done });
      samples.current.set(
        job.id,
        list.filter((sample) => now - sample.at <= SAMPLE_WINDOW_MS * 2),
      );
    }
    const activeJobs = parsed.data.active.filter((job) => !dismissed.current.has(job.id));
    const recentJobs = parsed.data.recent.filter((job) => !dismissed.current.has(job.id));
    setActive(activeJobs);
    setRecent(recentJobs);
    setNow(now);
    for (const job of recentJobs) {
      if (dismissTimers.current.has(job.id)) continue;
      const timer = setTimeout(() => {
        dismissTimers.current.delete(job.id);
        dismiss(job.id);
      }, DISMISS_MS);
      dismissTimers.current.set(job.id, timer);
    }
  }, [dismiss]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [load, pollMs]);

  useEffect(() => {
    return () => {
      for (const timer of dismissTimers.current.values()) clearTimeout(timer);
      dismissTimers.current.clear();
    };
  }, []);

  if (active.length === 0 && recent.length === 0) return null;

  const card = (job: JobDto, finished: boolean) => {
    const percent = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
    const eta = finished
      ? null
      : estimateEta(job, samples.current.get(job.id) ?? [], now, etas.current.get(job.id) ?? null);
    if (eta !== null) etas.current.set(job.id, eta);
    return (
      <article
        key={job.id}
        className={`jobs-tray__card jobs-tray__card--${job.status}`}
        aria-label={job.title}
      >
        <div className="jobs-tray__head">
          <strong>{job.title}</strong>
          <div className="jobs-tray__head-actions">
            {!finished && (
              <button
                type="button"
                className="jobs-tray__cancel"
                onClick={() => {
                  void apiFetch(`/api/v1/system/jobs/${job.id}/cancel`, {
                    method: 'POST',
                  }).then(() => load());
                }}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="jobs-tray__close"
              aria-label={`Dismiss ${job.title}`}
              title="Dismiss"
              onClick={() => dismiss(job.id)}
            >
              ×
            </button>
          </div>
        </div>
        <p className="jobs-tray__stage">
          {finished ? statusLabel(job.status) : (job.stage ?? 'working')}
          {job.total > 0 ? ` · ${job.done}/${job.total} ${job.unit}` : ''}
        </p>
        {!finished && (
          <div
            className="jobs-tray__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={job.total || 100}
            aria-valuenow={job.total > 0 ? job.done : undefined}
            aria-valuetext={percent === null ? 'working' : `${percent}%`}
          >
            <span style={{ width: `${percent ?? 12}%` }} />
          </div>
        )}
        <p className="jobs-tray__meta">
          {finished
            ? job.error
              ? job.error
              : 'finished'
            : `${percent === null ? 'working' : `${percent}%`} · ${
                eta === null ? 'estimating…' : formatEta(eta)
              }`}
        </p>
        {job.runId && onOpen && (
          <button type="button" className="jobs-tray__link" onClick={() => onOpen(job)}>
            View run
          </button>
        )}
      </article>
    );
  };

  return (
    <section className="jobs-tray" aria-live="polite" aria-label="Background jobs">
      {active.map((job) => card(job, false))}
      {recent.map((job) => card(job, true))}
    </section>
  );
}

function statusLabel(status: JobDto['status']): string {
  switch (status) {
    case 'succeeded':
      return 'Finished';
    case 'partial':
      return 'Finished with problems';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'awaiting':
      return 'Waiting for you';
    default:
      return 'Running';
  }
}
