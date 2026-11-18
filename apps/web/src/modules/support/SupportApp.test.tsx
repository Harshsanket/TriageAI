import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SupportApp from './SupportApp';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('support data-policy flag (phase 19.T6)', () => {
  it('flags an auto-reply through its run id', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? undefined });
      if (url === '/api/v1/support/tickets?limit=50') {
        return json([
          {
            id: 't1',
            subject: 'Double charge',
            body: 'I was charged twice',
            requester: 'customer',
            status: 'AWAITING_CUSTOMER',
            category: 'billing',
            confidence: 0.9,
            margin: 0.2,
            priority: 'high',
            team: 'billing',
            priorityCode: 'P1',
            teamId: 'billing',
            classification: null,
            routing: null,
            triage: null,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      if (url === '/api/v1/support/triage-policy') {
        return json({ priorities: ['P1'], teamIds: ['billing'], ambiguous: 'review' });
      }
      if (url === '/api/v1/support/tickets/t1') {
        return json({
          ticket: {
            id: 't1',
            subject: 'Double charge',
            body: 'I was charged twice',
            requester: 'customer',
            status: 'AWAITING_CUSTOMER',
            category: 'billing',
            confidence: 0.9,
            margin: 0.2,
            priority: 'high',
            team: 'billing',
            priorityCode: 'P1',
            teamId: 'billing',
            classification: null,
            routing: null,
            triage: null,
            createdAt: new Date().toISOString(),
          },
          messages: [
            {
              id: 'msg-1',
              authorType: 'system',
              author: 'system',
              body: 'The duplicate charge will be refunded.',
              runId: 'run-support-1',
              createdAt: new Date().toISOString(),
            },
          ],
          events: [],
        });
      }
      return json({ runId: 'run-support-1', flagged: true });
    });

    render(<SupportApp />);
    await userEvent.click(await screen.findByRole('button', { name: 'Double charge' }));
    await userEvent.click(await screen.findByRole('button', { name: 'flag reply msg-1' }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === '/api/v1/system/runs/run-support-1/flag' && call.init?.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Flagged for review')).toBeInTheDocument();
  });
});
