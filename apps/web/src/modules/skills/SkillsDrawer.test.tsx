import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SkillsDrawer } from './SkillsDrawer';

const skill = {
  id: 'skill-1',
  ownerId: null,
  scope: 'user',
  name: 'cite-policy',
  description: 'Cite the policy name in compliance answers.',
  content: '---\nname: cite-policy\ndescription: Cite the policy name.\n---\n\nAlways cite.',
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
  cleanup();
  vi.unstubAllGlobals();
});

describe('Skills drawer', () => {
  it('lists skills and toggles them', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? 'GET' });
        if (String(url).includes('/api/v1/skills/skill-1')) {
          return Response.json({ skill: { ...skill, enabled: false } });
        }
        return Response.json({ builtIn: [], skills: [skill], suggestions: [] });
      }),
    );
    render(<SkillsDrawer onClose={() => undefined} />);
    expect(await screen.findByText('cite-policy')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'cite-policy enabled' }));
    await waitFor(() =>
      expect(
        requests.some(
          (request) => request.url.includes('/api/v1/skills/skill-1') && request.method === 'PATCH',
        ),
      ).toBe(true),
    );
  });

  it('shows suggestions with Save and Ignore actions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          builtIn: [],
          skills: [],
          suggestions: [
            { ...skill, id: 'suggest-1', name: 'short-replies', suggestion: true, enabled: false },
          ],
        }),
      ),
    );
    render(<SkillsDrawer onClose={() => undefined} />);
    expect(await screen.findByText('short-replies')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
    expect(screen.getByText('Ignore')).toBeTruthy();
  });

  it('creates a skill from the description and instructions', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined });
        if (String(url).endsWith('/api/v1/skills') && init?.method === 'POST') {
          return Response.json({ skill });
        }
        return Response.json({ builtIn: [], skills: [], suggestions: [] });
      }),
    );
    render(<SkillsDrawer onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Describe the skill'), {
      target: { value: 'Answer with a short summary first.' },
    });
    fireEvent.change(screen.getByLabelText('Skill instructions'), {
      target: { value: 'Answer with a short summary first, then details.' },
    });
    fireEvent.click(screen.getByText('Create skill'));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/api/v1/skills') && call.body)).toBe(true),
    );
  });
});
