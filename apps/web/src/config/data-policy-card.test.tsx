import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DataPolicyCard } from './ConfigPage';

const data = {
  classes: [
    {
      id: 'support_tickets',
      sensitivity: 'internal',
      modelUse: 'redacted',
      retention: { mode: 'days', days: 365 },
      bounds: { minRetentionDays: 30, maxRetentionDays: 730 },
      effective: {
        retentionDays: 365,
        modelUse: 'redacted',
        sensitivity: 'internal',
        archiveBeforeDelete: false,
      },
      custom: false,
    },
    {
      id: 'audit_events',
      sensitivity: 'restricted',
      modelUse: 'never',
      retention: { mode: 'days', days: 400 },
      bounds: { minRetentionDays: 90, maxRetentionDays: 400, strictestModelUse: 'never' },
      effective: {
        retentionDays: 400,
        modelUse: 'never',
        sensitivity: 'restricted',
        archiveBeforeDelete: false,
      },
      custom: false,
    },
  ],
  overrides: {},
  presets: [],
  activePreset: null,
  version: 3,
  sendGate: { sent: 12, redacted: 4, withheld: 2 },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('data policy card bounds and send-gate stats (18.T18)', () => {
  it('constrains retention and model use to each class bounds', () => {
    render(<DataPolicyCard data={data} onSaved={() => undefined} />);
    const retention = screen.getByLabelText('support_tickets retention days');
    expect(retention).toHaveAttribute('min', '30');
    expect(retention).toHaveAttribute('max', '730');

    const auditModelUse = screen.getByLabelText('audit_events model use');
    expect(within(auditModelUse).getByRole('option', { name: 'never' })).not.toBeDisabled();
    expect(within(auditModelUse).getByRole('option', { name: 'allowed' })).toBeDisabled();
    expect(screen.getByText(/Send gate: 12 sent · 4 redacted · 2 withheld/)).toBeInTheDocument();
  });

  it('posts in-bounds overrides and shows the API rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { userMessage: 'support_tickets: retention must be between 30 and 730 days' },
          { status: 400 },
        ),
      ),
    );
    render(<DataPolicyCard data={data} onSaved={() => undefined} />);
    const retention = screen.getByLabelText('support_tickets retention days');
    await userEvent.clear(retention);
    await userEvent.type(retention, '10');
    await userEvent.click(screen.getByRole('button', { name: 'Save data policy' }));
    expect(
      await screen.findByText(/retention must be between 30 and 730 days/),
    ).toBeInTheDocument();
  });
});
