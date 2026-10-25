import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IntegrationsApp } from './IntegrationsApp';

const action = {
  id: 'a1',
  ticketId: 't1',
  kind: 'issue',
  channel: 'github-issue',
  status: 'pending_approval',
  reason: 'approval_required',
  ref: null,
  url: null,
  createdAt: new Date().toISOString(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('integrations approval UI', () => {
  it('lists pending actions and approves one', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ ...action, status: 'approved' }), { status: 200 });
      }
      return new Response(JSON.stringify([action]), { status: 200 });
    }) as unknown as typeof fetch;

    render(<IntegrationsApp provider="github" title="GitHub integration" />);
    expect(await screen.findByText('pending_approval')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(
      calls.some((call) => call.method === 'POST' && call.url.endsWith('/actions/a1/approve')),
    ).toBe(true);
  });
});
