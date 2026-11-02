import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemManifest } from '@triageai/contracts';

import HomePage from './HomePage';

vi.mock('./ocean', () => ({ AsciiOcean: () => null }));
vi.mock('../modules/chat/ChatApp', () => ({ default: () => <div data-testid="chat-app" /> }));

const manifest: SystemManifest = {
  generatedAt: new Date().toISOString(),
  modules: [
    {
      id: 'chat',
      version: '0.1.0',
      manifest: { routes: [], nav: [], background: [] },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('home skills drawer (phase 28.1)', () => {
  it('closes the skills drawer when the history sidebar opens and vice versa', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ builtIn: [], skills: [], suggestions: [] })),
    );
    const onToggleSidebar = vi.fn();
    const { rerender } = render(
      <HomePage manifest={manifest} sidebarOpen={false} onToggleSidebar={onToggleSidebar} />,
    );

    await userEvent.click(screen.getByLabelText('Open skills'));
    expect(await screen.findByRole('dialog', { name: 'Skills' })).toBeInTheDocument();

    rerender(<HomePage manifest={manifest} sidebarOpen={true} onToggleSidebar={onToggleSidebar} />);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Skills' })).not.toBeInTheDocument(),
    );

    expect(screen.queryByLabelText('Open skills')).not.toBeInTheDocument();
    rerender(
      <HomePage manifest={manifest} sidebarOpen={false} onToggleSidebar={onToggleSidebar} />,
    );
    await userEvent.click(screen.getByLabelText('Open skills'));
    expect(await screen.findByRole('dialog', { name: 'Skills' })).toBeInTheDocument();
  });
});
