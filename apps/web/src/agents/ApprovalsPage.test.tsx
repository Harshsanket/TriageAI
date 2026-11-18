import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ApprovalsPage from './ApprovalsPage';

const item = (id: string, body: string) => ({
  id,
  runId: 'run-1',
  stepId: 'send',
  toolName: 'support.reply',
  input: { body },
  preview: { summary: 'Send a reply', affects: ['ticket-1'] },
  status: 'pending',
  onExpiry: 'park_as_draft',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  createdAt: new Date().toISOString(),
  decidedAt: null,
  approver: null,
  reason: null,
});

const batches = {
  batches: [
    {
      runId: 'run-1',
      toolName: 'support.reply',
      count: 3,
      summary: '3 × Send a reply',
      items: [item('a1', 'One'), item('a2', 'Two'), item('a3', 'Three')],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      onExpiry: 'park_as_draft',
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approvals inbox (phase 15.T9)', () => {
  it('lists batches and approves a subset as one decision', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (init?.method === 'POST') {
          return Response.json({ approvals: [item('a2', 'Two')] });
        }
        return Response.json(batches);
      }),
    );
    render(<ApprovalsPage />);
    expect(await screen.findByRole('heading', { name: 'Approvals' })).toBeInTheDocument();
    expect(await screen.findByText(/3 × Send a reply/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Select a2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve selected' }));

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.init?.method === 'POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      ids: ['a2'],
      outcome: 'approve',
    });
    expect(await screen.findByText('Approved 1 call.')).toBeInTheDocument();
  });

  it('requires a reason before rejecting', async () => {
    const posts: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(JSON.parse(String(init.body)));
          return Response.json({ approvals: [item('a1', 'One')] });
        }
        return Response.json({ batches: [batches.batches[0]] });
      }),
    );
    render(<ApprovalsPage />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Select all support.reply' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Reject selected' }));
    expect(await screen.findByText('A rejection reason is required.')).toBeInTheDocument();
    expect(posts).toHaveLength(0);

    await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'not grounded');
    await userEvent.click(screen.getByRole('button', { name: 'Reject selected' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      ids: ['a1', 'a2', 'a3'],
      outcome: 'reject',
      reason: 'not grounded',
    });
  });
});
