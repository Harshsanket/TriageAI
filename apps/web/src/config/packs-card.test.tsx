import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PacksCard } from './ConfigPage';

const pack = {
  id: 'ticket-solver',
  version: '1.0.0',
  name: 'Ticket solver',
  license: 'MIT',
  sha256: 'a'.repeat(64),
  modules: ['support', 'classifier-provider'],
  skills: ['handoff'],
  agents: ['reviewer'],
  installedBy: 'admin@example.com',
  installedAt: new Date().toISOString(),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('packs card (22.T12)', () => {
  it('lists installed packs and shows per-item install results', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method ?? 'GET',
          body: init?.body ? String(init.body) : undefined,
        });
        if (String(url) === '/api/v1/plugins' && (init?.method ?? 'GET') === 'GET') {
          return Response.json({ installed: [], packs: [pack] });
        }
        return Response.json({
          pack,
          ok: true,
          items: [
            { id: 'support', kind: 'module', status: 'builtin' },
            { id: 'handoff', kind: 'skill', status: 'imported' },
          ],
        });
      }),
    );

    render(<PacksCard />);
    expect(await screen.findByText('Ticket solver')).toBeInTheDocument();
    expect(screen.getByText(/2 modules/)).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText('Pack URL'),
      'https://example.com/ticket-solver-1.0.0.tgz',
    );
    await userEvent.type(screen.getByLabelText('Pack signature'), 'c2lnbmF0dXJl');
    await userEvent.click(screen.getByRole('button', { name: 'Install pack' }));

    expect(await screen.findByText(/Verified and installed ticket-solver/)).toBeInTheDocument();
    expect(screen.getByLabelText('Pack install results')).toHaveTextContent(
      'module support · builtin',
    );
    const install = calls.find(
      (call) => call.url === '/api/v1/plugins/install' && call.method === 'POST',
    );
    expect(install?.body).toContain('"packUrl":"https://example.com/ticket-solver-1.0.0.tgz"');
    expect(install?.body).toContain('"signature":"c2lnbmF0dXJl"');
  });

  it('shows verification failures without claiming success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url) === '/api/v1/plugins' && (init?.method ?? 'GET') === 'GET') {
          return Response.json({ installed: [], packs: [] });
        }
        return Response.json(
          { userMessage: 'pack verification failed: pack signature is invalid' },
          { status: 400 },
        );
      }),
    );
    render(<PacksCard />);
    expect(await screen.findByText('No packs installed.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Pack URL'), 'https://example.com/bad.tgz');
    await userEvent.type(screen.getByLabelText('Pack signature'), 'YmFk');
    await userEvent.click(screen.getByRole('button', { name: 'Install pack' }));
    expect(
      await screen.findByText(/pack verification failed: pack signature is invalid/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Verified and installed/)).not.toBeInTheDocument();
  });
});
