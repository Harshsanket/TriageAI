import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutonomyCard } from './ConfigPage';

const flows = {
  flows: [
    {
      key: 'support.auto_reply::billing',
      flow: 'support.auto_reply',
      category: 'billing',
      level: 'draft',
      cleanRunStreak: 5,
      promoteAfter: 5,
      lastChange: null,
      suggestion: { level: 'internal_note', reason: 'promotion_suggested' },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('autonomy suggestion card (phase 15.T10)', () => {
  it('shows the suggested level read-only and accepts it explicitly', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (init?.method === 'PUT') return Response.json({ level: 'internal_note' });
        return Response.json(flows);
      }),
    );
    render(<AutonomyCard />);
    expect(await screen.findByText(/suggestion: internal_note/)).toBeInTheDocument();
    expect(screen.getByText(/5\/5 clean runs/)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', {
        name: 'Accept internal_note for support.auto_reply (billing)',
      }),
    );
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.init?.method === 'PUT');
    expect(put?.url).toBe('/api/v1/system/autonomy/support.auto_reply');
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      category: 'billing',
      level: 'internal_note',
    });
    expect(
      await screen.findByText(/Accepted internal_note for support.auto_reply/),
    ).toBeInTheDocument();
  });
});
