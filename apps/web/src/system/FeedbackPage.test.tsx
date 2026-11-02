import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FeedbackPage from './FeedbackPage';

const now = new Date().toISOString();
const insights = {
  items: [
    {
      id: 'c1',
      source: 'correction',
      status: 'proposed',
      rating: 'neutral',
      reason: 'wrong_category',
      text: 'refund',
      answer: 'Billing answer',
      citations: ['Refund policy'],
      module: 'support',
      agent: 'Voyager',
      conversationId: null,
      ticketId: 't1',
      model: 'qwen2.5:1.5b',
      promptVersion: '1',
      createdAt: now,
      timeline: [
        { step: 'received', at: now, detail: 'correction', href: null, status: 'done' },
        { step: 'triaged', at: now, detail: 'candidate created', href: null, status: 'done' },
        { step: 'reviewed', at: now, detail: 'proposed', href: null, status: 'pending' },
      ],
    },
  ],
  graphs: {
    volume: [{ bucket: now.slice(0, 10), bySource: { correction: 1 } }],
    sentiment: [{ bucket: now.slice(0, 10), positive: 0, negative: 0 }],
    topReasons: [{ reason: 'wrong_category', count: 1 }],
    funnel: { received: 1, reviewed: 0, accepted: 0, used: 0 },
    avgReviewHours: null,
  },
};

function mockApi() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/api/v1/system/candidates/c1') && method === 'PATCH') {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    if (url.includes('/api/v1/system/feedback-insights')) {
      return new Response(JSON.stringify(insights), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('feedback insights page', () => {
  it('shows source, detail, timeline and the four graphs', async () => {
    mockApi();
    render(<FeedbackPage />);

    expect(await screen.findByText('Feedback insights')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Volume' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Positive vs negative' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Top reasons' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Processing funnel' })).toBeInTheDocument();
    expect(screen.getAllByText('wrong_category').length).toBeGreaterThan(0);
    expect(screen.getByText(/Billing answer/)).toBeInTheDocument();
    expect(screen.getByLabelText('Processing timeline')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Voyager/)).toBeInTheDocument();
  });

  it('approves a proposed item', async () => {
    const fetchMock = mockApi();
    render(<FeedbackPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const patch = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/api/v1/system/candidates/c1') &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patch).toBeTruthy();
    expect(String((patch?.[1] as RequestInit).body)).toContain('"status":"approved"');
  });
});
