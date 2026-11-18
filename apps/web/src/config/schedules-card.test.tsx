import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SchedulesCard } from './ConfigPage';

const schedules = {
  schedules: [
    {
      id: 'evals.nightly',
      module: 'evals',
      cron: '0 2 * * *',
      probe: { kind: 'watermark', read: 'table:workflow_runs:count' },
      silentWhenEmpty: true,
      managed: true,
      nextRunAt: '2026-11-12T02:00:00.000Z',
      state: {
        watermark: { value: '12' },
        lastRunAt: '2026-11-11T02:00:00.000Z',
        lastStatus: 'no_change',
        skippedOverlap: 1,
      },
      receipt: {
        runs: 2,
        noChange: 2,
        useful: 0,
        neededHuman: 0,
        repeatedFailures: 0,
        skippedOverlap: 1,
        manualRuns: 0,
        cost: 0.4,
        costPerUsefulRun: null,
        lastUsefulAt: null,
        suggestion: 'retire',
      },
      acceptedSuggestion: null,
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('schedules receipt card (19.T8)', () => {
  it('shows the receipt and accepts a suggestion explicitly', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (init?.method === 'PUT') {
          return Response.json({ scheduleId: 'evals.nightly', suggestion: 'retire' });
        }
        return Response.json(schedules);
      }),
    );
    render(<SchedulesCard />);
    expect(await screen.findByText('evals.nightly')).toBeInTheDocument();
    expect(screen.getByText(/2 no-change/)).toBeInTheDocument();
    expect(screen.getByText(/1 skipped/)).toBeInTheDocument();
    expect(screen.getByText(/suggestion: retire/)).toBeInTheDocument();
    expect(screen.getByText(/watermark 12/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Accept retire for evals.nightly' }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.init?.method === 'PUT');
    expect(put?.url).toBe('/api/v1/system/schedules/evals.nightly/suggestion');
    expect(JSON.parse(String(put?.init?.body))).toEqual({ suggestion: 'retire', days: 30 });
    expect(await screen.findByText(/Accepted retire for evals.nightly/)).toBeInTheDocument();
  });

  it('starts a manual run from the card', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (init?.method === 'POST') return Response.json({ runId: 'run-1' });
        return Response.json(schedules);
      }),
    );
    render(<SchedulesCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run now evals.nightly' }));
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.init?.method === 'POST')?.url).toBe(
      '/api/v1/system/schedules/evals.nightly/run',
    );
    expect(await screen.findByText(/Started a manual run/)).toBeInTheDocument();
  });
});
