import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AgentsPage from './AgentsPage';

const agent = {
  id: 'agent-1',
  displayName: 'Researcher',
  color: '#3b6fd4',
  status: 'running',
  paused: false,
  runs: 2,
  latestRun: {
    id: 'run-1',
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
  },
};

const detail = {
  agent,
  definition: { profile: 'Research things', job: { doneWhen: 'cited' } },
  runs: [agent.latestRun],
  steps: [
    {
      runId: 'run-1',
      step: 0,
      decision: 'call_tool',
      at: new Date().toISOString(),
      reason: 'need facts',
      context: { hash: 'abc123', needs: ['knowledge'], tokens: { total: 42 } },
    },
  ],
};

const external = {
  agents: [
    { id: 'ext-1', name: 'External Bot', enabled: true, createdAt: new Date().toISOString() },
  ],
  handoffs: [
    {
      id: 'handoff-1',
      agentId: 'ext-1',
      fromAgentId: 'agent-1',
      goal: 'Investigate the sync failure',
      status: 'pending',
      createdAt: new Date().toISOString(),
      fetchedAt: null,
    },
  ],
  steps: [
    {
      id: 'step-1',
      agentId: 'ext-1',
      runId: 'ext-run-1',
      step: 'received',
      at: new Date().toISOString(),
    },
  ],
};

const memoryDetail = {
  ...detail,
  memory: {
    entries: [
      {
        id: 'memory-1',
        scope: 'agent',
        scopeId: 'agent-1',
        kind: 'preference',
        text: 'The user prefers concise answers',
        sourceRefs: ['ticket:1'],
        confidence: 1,
        status: 'active',
        useCount: 2,
        lastUsedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        derivedFromUntrusted: false,
        sensitivity: 'internal',
      },
      {
        id: 'memory-2',
        scope: 'agent',
        scopeId: 'agent-1',
        kind: 'fact',
        text: 'Refunds take five days.',
        sourceRefs: ['ticket:2'],
        confidence: 1,
        status: 'active',
        useCount: 0,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        derivedFromUntrusted: false,
        sensitivity: 'internal',
      },
    ],
    markdown: '# Memory\n\n## agent:agent-1\n\n- [fact] Refunds take five days.\n',
    total: 2,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/agents monitor (phase 17.T2/T3)', () => {
  it('lists agents and external agents, shows steps and pauses an agent', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url: String(url), method });
        if (method === 'POST') {
          return Response.json({ agentId: 'agent-1', paused: true });
        }
        if (String(url) === '/api/v1/agents') {
          return Response.json({
            agents: [agent],
            teams: [
              {
                runId: 'team-run-1',
                teamId: 'research',
                topology: 'pipeline',
                status: 'SUCCEEDED',
                agents: 2,
                createdAt: new Date().toISOString(),
              },
            ],
            packProfiles: [
              {
                id: 'pack:demo:reviewer',
                name: 'Pack Reviewer',
                packId: 'demo-pack',
                importedAt: new Date().toISOString(),
                body: '# Reviewer',
                source: 'pack',
                readOnly: true,
              },
            ],
          });
        }
        if (String(url) === '/api/v1/agents/agent-1') return Response.json(detail);
        if (String(url) === '/api/v1/public-api/external-agents/activity') {
          return Response.json(external);
        }
        return Response.json({});
      }),
    );

    render(<AgentsPage />);
    expect(await screen.findByRole('heading', { name: 'Agents', level: 2 })).toBeInTheDocument();
    expect(await screen.findByText('Researcher')).toBeInTheDocument();
    expect(await screen.findByText('External Bot')).toBeInTheDocument();
    expect(await screen.findByText('Pack Reviewer')).toBeInTheDocument();
    expect(await screen.findByText('pack · read-only')).toBeInTheDocument();
    expect(await screen.findByText('Investigate the sync failure')).toBeInTheDocument();
    expect(await screen.findByText(/context abc123/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(calls.some((call) => call.url.endsWith('/api/v1/agents/agent-1/pause'))).toBe(true),
    );
    expect(await screen.findByText(/paused/)).toBeInTheDocument();
  });

  it('lists, searches and exports agent memories without a new route', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url) === '/api/v1/agents') {
          return Response.json({ agents: [agent], teams: [] });
        }
        if (String(url) === '/api/v1/agents/agent-1') return Response.json(memoryDetail);
        if (String(url) === '/api/v1/public-api/external-agents/activity') {
          return Response.json({ agents: [], handoffs: [], steps: [] });
        }
        return Response.json({});
      }),
    );

    render(<AgentsPage />);
    expect(await screen.findByText('The user prefers concise answers')).toBeInTheDocument();
    expect(screen.getByText('Refunds take five days.')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Search memory'), 'refund');
    expect(screen.queryByText('The user prefers concise answers')).not.toBeInTheDocument();
    expect(screen.getByText('Refunds take five days.')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Export memory.md' });
    expect(link).toHaveAttribute('download', 'memory.md');
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('data:text/markdown')).toBe(true);
    expect(decodeURIComponent(href)).toContain('# Memory');
    expect(decodeURIComponent(href)).toContain('Refunds take five days.');
  });
});
