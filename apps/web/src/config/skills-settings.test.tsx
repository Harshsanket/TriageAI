import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SkillsSettingsCard } from './ConfigPage';

const skill = {
  id: 'skill-1',
  ownerId: 'u1',
  scope: 'user',
  name: 'cite-policy',
  description: 'Cite the policy name in compliance answers.',
  content: 'Always cite.',
  enabled: true,
  version: 1,
  provenance: 'custom',
  sourceUrl: null,
  sourceRef: null,
  license: null,
  suggestion: false,
  ignored: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('skills settings sections (phase 28.3)', () => {
  it('defaults to List of skills and switches to Add skills', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/api/v1/skills/sources')) {
          return Response.json({ sources: [] });
        }
        return Response.json({ builtIn: [], skills: [skill], suggestions: [] });
      }),
    );
    render(<SkillsSettingsCard />);
    expect(await screen.findByRole('tab', { name: 'List of skills' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('switch', { name: 'cite-policy enabled' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete cite-policy' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Add skills' }));
    expect(screen.getByRole('tab', { name: 'Add skills' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Add from GitHub')).toBeInTheDocument();
  });

  it('deletes a skill from the list', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        if (String(url).includes('/api/v1/skills/sources')) {
          return Response.json({ sources: [] });
        }
        if (init?.method === 'DELETE') return Response.json({ deleted: true });
        return Response.json({ builtIn: [], skills: [skill], suggestions: [] });
      }),
    );
    vi.stubGlobal('confirm', () => true);
    render(<SkillsSettingsCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete cite-policy' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/v1/skills/skill-1'));
  });
});
