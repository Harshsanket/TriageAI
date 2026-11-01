import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JobDto } from '@triageai/contracts';

import { JobsTray, estimateEta } from './JobsTray';

const job = (patch: Partial<JobDto> = {}): JobDto => ({
  id: 'job-1',
  runId: 'run-1',
  workflowId: 'kb.ingest',
  title: 'Importing 12 files to Personal finance',
  stage: 'embedding',
  done: 6,
  total: 12,
  unit: 'files',
  status: 'running',
  error: null,
  ownerId: null,
  createdAt: new Date(Date.now() - 10_000).toISOString(),
  updatedAt: new Date().toISOString(),
  ...patch,
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('jobs tray (phase 20.1)', () => {
  it('shows active jobs, estimates an ETA and cancels', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/v1/system/jobs') {
        return new Response(JSON.stringify({ active: [job()], recent: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ cancelled: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    render(<JobsTray pollMs={60_000} />);
    expect(await screen.findByText('Importing 12 files to Personal finance')).toBeInTheDocument();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls).toContain('POST /api/v1/system/jobs/job-1/cancel'));
  });

  it('keeps dismissed notifications hidden after a reload', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ active: [job()], recent: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const first = render(<JobsTray pollMs={60_000} />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Dismiss Importing 12 files to Personal finance' }),
    );
    expect(screen.queryByText('Importing 12 files to Personal finance')).not.toBeInTheDocument();
    first.unmount();

    render(<JobsTray pollMs={60_000} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('Importing 12 files to Personal finance')).not.toBeInTheDocument();
  });

  it('dismisses a finished notification after 8s and every card has a close button', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              active: [],
              recent: [job({ id: 'finished-1', status: 'failed', error: 'boom' })],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ) as unknown as typeof fetch;
      render(<JobsTray pollMs={60_000} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(screen.getByText('Importing 12 files to Personal finance')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /Dismiss Importing 12 files/ }),
      ).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(8_000);
      });
      expect(screen.queryByText('Importing 12 files to Personal finance')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the close button hide a running notification', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ active: [job()], recent: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    render(<JobsTray pollMs={60_000} />);
    expect(await screen.findByText(/Importing 12 files/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Dismiss Importing 12 files/ }));
    expect(screen.queryByText(/Importing 12 files/)).not.toBeInTheDocument();
  });

  it('shows an inline ETA once two samples span three seconds', () => {
    const running = job({ total: 10, done: 4 });
    const now = Date.now();
    const eta = estimateEta(
      running,
      [
        { at: now - 4_000, done: 0 },
        { at: now, done: 4 },
      ],
      now,
      null,
    );
    expect(eta).toBe(6_000);
    expect(
      estimateEta(
        { ...running, createdAt: new Date(now).toISOString() },
        [
          { at: now - 100, done: 2 },
          { at: now, done: 4 },
        ],
        now,
        null,
      ),
    ).toBeNull();
  });

  it('keeps a card after a remount because state comes from the server', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ active: [job()], recent: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const first = render(<JobsTray pollMs={60_000} />);
    expect(await screen.findByText(/Importing 12 files/)).toBeInTheDocument();
    first.unmount();
    render(<JobsTray pollMs={60_000} />);
    expect(await screen.findByText(/Importing 12 files/)).toBeInTheDocument();
  });
});
