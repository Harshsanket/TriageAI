import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import RunsPage from './RunsPage';

const run = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  workflowId: 'support.triage',
  workflowVersion: '1.0.0',
  trigger: 'endpoint',
  status: 'SUCCEEDED',
  input: null,
  output: null,
  error: null,
  createdAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runs daily summary (phase 35)', () => {
  it('shows runs grouped by day with workflow, outcome and data-access counts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/v1/system/runs/daily')) {
          return Response.json({
            days: [
              {
                date: '2026-11-02',
                totalRuns: 4,
                workflows: ['support.triage', 'chat.reply'],
                succeeded: 3,
                failed: 1,
                sensitiveRuns: 2,
                dataTouchedRuns: 3,
              },
            ],
          });
        }
        return Response.json([run]);
      }),
    );
    render(<RunsPage />);
    expect(await screen.findByText('Daily summary')).toBeInTheDocument();
    expect(await screen.findByText('2026-11-02')).toBeInTheDocument();
    expect(screen.getByText('support.triage, chat.reply')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Sensitive data')).toBeInTheDocument();
    expect(screen.getByText('Touched data')).toBeInTheDocument();
  });
});
