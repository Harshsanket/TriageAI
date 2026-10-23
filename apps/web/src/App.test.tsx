import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

function mockManifest(modules: string[]) {
  const all: Record<
    string,
    {
      nav: { label: string; order: number; path: string }[];
      routes: { path: string; title: string }[];
      background: [];
    }
  > = {
    echo: {
      nav: [{ label: 'Echo', order: 10, path: '/echo' }],
      routes: [{ path: '/echo', title: 'Echo' }],
      background: [],
    },
    chat: {
      nav: [{ label: 'Chat', order: 20, path: '/chat' }],
      routes: [{ path: '/chat', title: 'Chat' }],
      background: [],
    },
  };
  const manifest = {
    generatedAt: new Date().toISOString(),
    modules: modules.map((id) => ({
      id,
      version: '0.1.0',
      manifest: all[id] ?? { routes: [], nav: [], background: [] },
    })),
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/v1/system/manifest')) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, '', '/');
});

describe('App module host', () => {
  it('renders home with heading and no modules when manifest is empty', async () => {
    mockManifest([]);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'TriageAI' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Echo' })).not.toBeInTheDocument();
  });

  it('gating: enabled module appears in nav, disabled module leaves zero orphans', async () => {
    mockManifest(['echo']); // chat disabled in config → not in manifest at all
    render(<App />);
    await screen.findByRole('button', { name: 'Echo' });
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();
  });

  it('navigates to an enabled module page', async () => {
    mockManifest(['echo']);
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Echo' }));
    expect(await screen.findByRole('heading', { name: 'Echo' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/echo');
  });
});

describe('run inspector (host page)', () => {
  it('lists runs with status and navigates to the detail view', async () => {
    window.history.pushState({}, '', '/runs');
    const run = {
      id: 'run-1',
      workflowId: 'echo.run',
      workflowVersion: '0.1.0',
      trigger: 'endpoint',
      status: 'SUCCEEDED',
      input: { text: 'hi' },
      output: null,
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    const detail = {
      run,
      stages: [
        {
          id: 's1',
          runId: 'run-1',
          stageId: 'upper',
          kind: 'echo.upper',
          status: 'SUCCEEDED',
          attempts: 1,
          output: { upper: 'HI' },
          error: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ],
      decisions: [
        {
          id: 'd1',
          runId: 'run-1',
          stageRunId: 's1',
          workflowId: 'echo.run',
          moduleId: 'echo',
          moduleVersion: '0.1.0',
          evidence: { kind: 'deterministic' },
          deterministic: { text: 'hi' },
          timings: { durationMs: 2 },
          error: null,
          createdAt: new Date().toISOString(),
          fallback: null,
          outcome: { status: 'SUCCEEDED' },
        },
      ],
    };
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.startsWith('/api/v1/system/runs/run-1')) {
        return new Response(JSON.stringify(detail), { status: 200 });
      }
      if (url.startsWith('/api/v1/system/runs')) {
        return new Response(JSON.stringify([run]), { status: 200 });
      }
      return new Response(JSON.stringify({ generatedAt: new Date().toISOString(), modules: [] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Runs' })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'run-1' }));
    expect(await screen.findByText(/Run run-1/)).toBeInTheDocument();
    expect((await screen.findAllByText('evidence')).length).toBeGreaterThan(0);
  });
});
