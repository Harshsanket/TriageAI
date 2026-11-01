import { render, screen, waitFor } from '@testing-library/react';
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
      nav: [{ label: 'Chat', order: 20, path: '/' }],
      routes: [],
      background: [],
    },
    kb: {
      nav: [{ label: 'Knowledge base', order: 30, path: '/kb' }],
      routes: [{ path: '/kb', title: 'Knowledge base' }],
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
  const setupStatus = {
    state: 'complete',
    tokenRequired: false,
    restartRequired: false,
    lastError: null,
    overlayVersion: 1,
    secretStoreAvailable: true,
  };
  const fetchMock = vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/v1/system/manifest')) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/v1/setup/status') {
      return new Response(JSON.stringify(setupStatus), { status: 200 });
    }
    if (url === '/api/v1/setup/config/effective') {
      return new Response(
        JSON.stringify({
          bootedOverlayVersion: 1,
          latestOverlay: null,
          history: [],
          running: { profile: 'support', modules: {}, capabilities: {} },
          authMode: 'disabled',
          authModeSource: 'config',
        }),
        { status: 200 },
      );
    }
    if (url === '/api/v1/setup/secrets') {
      return new Response(JSON.stringify({ available: true, secrets: [] }), { status: 200 });
    }
    if (url === '/api/v1/system/data-policy') {
      return new Response(JSON.stringify({ classes: [], sendGate: {} }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.pushState({}, '', '/');
  delete (globalThis as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
});

describe('App module host', () => {
  it('redirects to /config when no user-facing module is enabled', async () => {
    mockManifest([]);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Setup' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/config');
    expect(screen.queryByRole('button', { name: 'Echo' })).not.toBeInTheDocument();
  });

  it('sends an unknown path to /config instead of a dead end', async () => {
    window.history.pushState({}, '', '/not-a-page');
    mockManifest(['echo']);
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Setup' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/config');
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
      return new Response(
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          modules: [
            {
              id: 'echo',
              version: '0.1.0',
              manifest: {
                routes: [{ path: '/echo', title: 'Echo' }],
                nav: [{ label: 'Echo', order: 10, path: '/echo' }],
                background: [],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Runs' })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'run-1' }));
    expect(await screen.findByText(/Run run-1/)).toBeInTheDocument();
    expect((await screen.findAllByText('evidence')).length).toBeGreaterThan(0);
  });
});

describe('support module (manifest gated)', () => {
  it('shows Support from the manifest and renders the ticket queue', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/system/manifest')) {
        return new Response(
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            modules: [
              {
                id: 'support',
                version: '0.1.0',
                manifest: {
                  routes: [{ path: '/support', title: 'Support' }],
                  nav: [{ label: 'Support', order: 5, path: '/support' }],
                  background: [],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/api/v1/support/tickets')) {
        return new Response(
          JSON.stringify([
            {
              id: 't1',
              subject: 'Double charge',
              body: 'charged twice',
              requester: 'me',
              status: 'ROUTED',
              category: 'billing',
              confidence: 0.9,
              margin: 0.3,
              priority: 'high',
              team: 'billing',
              classification: null,
              routing: null,
              createdAt: new Date().toISOString(),
            },
          ]),
          { status: 200 },
        );
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    window.history.pushState({}, '', '/');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Support' }));
    expect(await screen.findByRole('heading', { name: 'Support' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Double charge' })).toBeInTheDocument();
  });
});

describe('dashboard (host page)', () => {
  const dashboard = {
    generatedAt: new Date().toISOString(),
    health: {
      status: 'healthy',
      database: 'up',
      modules: [{ id: 'kb', version: '0.1.0', health: 'healthy' }],
      capabilities: [{ id: 'embedder', adapter: 'ai-service' }],
      queue: { pending: 2, processing: 1, deadLetters: 0 },
    },
    activity: {
      runsLastHour: 4,
      activeRuns: 1,
      recentRuns: [
        {
          id: 'run-1',
          workflowId: 'echo.run',
          status: 'SUCCEEDED',
          createdAt: new Date().toISOString(),
        },
      ],
    },
    knowledge: { documents: 3, pendingApproval: 1 },
    security: {
      authMode: 'disabled',
      usersByRole: { customer: 1, agent: 2, admin: 1 },
      auditEventsLastDay: 5,
    },
  };

  function mockDashboard(modules: string[]) {
    const baseFetch = mockManifest(modules);
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/api/v1/system/dashboard')) {
        return new Response(JSON.stringify(dashboard), { status: 200 });
      }
      if (url.includes('/api/v1/system/hw')) {
        return new Response(
          JSON.stringify({
            capturedAt: new Date().toISOString(),
            uptimeSec: 60,
            cpuCount: 8,
            loadAvg: [0.1, 0.2, 0.3],
            memoryTotalBytes: 1024,
            memoryFreeBytes: 512,
            processRssBytes: 128,
            processHeapUsedBytes: 64,
            queuePending: 0,
            queueProcessing: 0,
          }),
          { status: 200 },
        );
      }
      return baseFetch(url);
    }) as unknown as typeof fetch;
  }

  it('renders health, activity and security tiles and links to a drill-down', async () => {
    window.history.pushState({}, '', '/dashboard');
    mockDashboard(['kb']);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByText('3 documents')).toBeInTheDocument();
    expect(screen.getByText('2 pending · 1 processing · 0 dead')).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'Machine' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dead letters' })).toBeInTheDocument();
    window.history.pushState({}, '', '/system');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(window.location.pathname).toBe('/dashboard'));
  });

  it('hides the knowledge tile when the KB module is disabled', async () => {
    window.history.pushState({}, '', '/dashboard');
    mockDashboard(['echo']);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Health' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Knowledge' })).not.toBeInTheDocument();
  });
});

describe('home page', () => {
  it('starts a conversation in place on /', async () => {
    mockManifest(['chat']);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const fallback = fetchMock.getMockImplementation() as typeof fetch;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/chat/messages' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ conversationId: 'c1', messageId: 'm1', runId: 'r1' }),
          {
            status: 200,
          },
        );
      }
      if (url === '/api/v1/chat/conversations') {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url === '/api/v1/chat/conversations/c1') {
        return new Response(
          JSON.stringify({
            conversationId: 'c1',
            messages: [
              {
                id: 'm2',
                conversationId: 'c1',
                role: 'assistant',
                content: 'Refunds take five days.',
                citations: [],
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      return fallback(url, init);
    }) as unknown as typeof fetch;

    render(<App />);

    const input = await screen.findByLabelText('Ask TriageAI anything');
    await userEvent.type(input, 'Where is the refund policy?');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('heading', { name: 'Chat' })).toBeInTheDocument();
    expect(await screen.findByText('Refunds take five days.')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');

    await userEvent.click(screen.getByRole('button', { name: 'Show conversation history' }));
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(await screen.findByLabelText('Ask TriageAI anything')).toBeInTheDocument();
  });

  it('attaches text files to the message and clears them after send', async () => {
    mockManifest(['chat']);
    const fallback = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).getMockImplementation() as typeof fetch;
    let sentBody = '';
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/chat/messages' && init?.method === 'POST') {
        sentBody = String(init.body);
        return new Response(
          JSON.stringify({ conversationId: 'c-file', messageId: 'm', runId: 'r' }),
          {
            status: 200,
          },
        );
      }
      if (url === '/api/v1/chat/conversations') {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url === '/api/v1/chat/conversations/c-file') {
        return new Response(JSON.stringify({ conversationId: 'c-file', messages: [] }), {
          status: 200,
        });
      }
      return fallback(url, init);
    }) as unknown as typeof fetch;

    render(<App />);
    const input = await screen.findByLabelText('Choose files');
    await userEvent.upload(
      input,
      new File(['Notes from the file.'], 'notes.txt', { type: 'text/plain' }),
    );
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(await screen.findByText('Attached: notes.txt')).toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('Ask TriageAI anything'), 'Please read this');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(sentBody).toContain('Notes from the file.'));
    expect(sentBody).toContain('notes.txt');
  });

  it('adds chat attachments to the knowledge base as enabled sources', async () => {
    mockManifest(['chat', 'kb']);
    const fallback = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).getMockImplementation() as typeof fetch;
    let sourceBody = '';
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/kb/sources' && init?.method === 'POST') {
        sourceBody = String(init.body);
        return new Response(JSON.stringify({ source: { id: 's1' } }), { status: 200 });
      }
      if (url === '/api/v1/chat/messages' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ conversationId: 'c-kb', messageId: 'm', runId: 'r' }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/chat/conversations') {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url === '/api/v1/chat/conversations/c-kb') {
        return new Response(JSON.stringify({ conversationId: 'c-kb', messages: [] }), {
          status: 200,
        });
      }
      return fallback(url, init);
    }) as unknown as typeof fetch;

    render(<App />);
    await userEvent.upload(
      await screen.findByLabelText('Choose files'),
      new File(['Refund policy notes.'], 'policy.txt', { type: 'text/plain' }),
    );
    await userEvent.type(await screen.findByLabelText('Ask TriageAI anything'), 'Read this');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(sourceBody).toContain('policy.txt'));
    expect(sourceBody).toContain('contentBase64');
  });

  it('refuses video uploads', async () => {
    mockManifest(['chat']);
    render(<App />);
    const input = await screen.findByLabelText('Choose files');
    await userEvent.upload(input, new File(['video bytes'], 'clip.mp4', { type: 'video/mp4' }), {
      applyAccept: false,
    });
    expect(
      await screen.findByText(/clip.mp4 is a video and cannot be uploaded/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove clip.mp4')).not.toBeInTheDocument();
  });

  it('dictates into the composer with the microphone button', async () => {
    mockManifest(['chat']);
    let started = false;
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = 'en-US';
      onresult:
        ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
      onerror: (() => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        started = true;
        this.onresult?.({ results: [[{ transcript: 'refund policy please' }]] });
        this.onend?.();
      }
      stop() {
        this.onend?.();
      }
    }
    (globalThis as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Use microphone' }));
    expect(started).toBe(true);
    expect(await screen.findByLabelText('Ask TriageAI anything')).toHaveValue(
      'refund policy please',
    );
  });

  it('labels assistant replies with the chat agent name and colour', async () => {
    mockManifest(['chat']);
    const fallback = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).getMockImplementation() as typeof fetch;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/chat/messages' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ conversationId: 'c-agent', messageId: 'm', runId: 'r' }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/chat/conversations') {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url === '/api/v1/chat/conversations/c-agent') {
        return new Response(
          JSON.stringify({
            conversationId: 'c-agent',
            messages: [
              {
                id: 'm1',
                conversationId: 'c-agent',
                role: 'assistant',
                content: 'Hello!',
                citations: [],
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/me/preferences') {
        return new Response(
          JSON.stringify({
            preferences: {
              theme: 'auto',
              fontSize: 'default',
              motion: 'auto',
              agents: [{ id: 'chat', displayName: 'Voyager', color: '#3b6fd4' }],
              chatSidebar: false,
            },
            defaults: null,
            agents: [{ id: 'chat', displayName: 'Voyager', color: '#3b6fd4' }],
          }),
          { status: 200 },
        );
      }
      return fallback(url, init);
    }) as unknown as typeof fetch;

    render(<App />);
    await userEvent.type(await screen.findByLabelText('Ask TriageAI anything'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Voyager')).toBeInTheDocument();
    expect(screen.queryByText(/^assistant$/i)).not.toBeInTheDocument();
  });

  it('keeps the conversation after a reload and reopens it from the sidebar', async () => {
    mockManifest(['chat']);
    const fallback = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).getMockImplementation() as typeof fetch;
    let sent = false;
    const preferences = {
      preferences: {
        theme: 'auto',
        fontSize: 'default',
        motion: 'auto',
        agents: [],
        chatSidebar: false,
      },
      defaults: null,
      agents: [],
    };
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/chat/messages' && init?.method === 'POST') {
        sent = true;
        return new Response(
          JSON.stringify({ conversationId: 'c1', messageId: 'm1', runId: 'r1' }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/chat/conversations') {
        return new Response(
          JSON.stringify({
            conversations: sent
              ? [
                  {
                    id: 'c1',
                    title: 'Refund policy',
                    pinned: false,
                    summary: null,
                    lastMessage: 'Refunds take five days.',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                ]
              : [],
          }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/chat/conversations/c1') {
        return new Response(
          JSON.stringify({
            conversationId: 'c1',
            messages: [
              {
                id: 'm1',
                conversationId: 'c1',
                role: 'user',
                content: 'How long do refunds take?',
                citations: [],
                createdAt: new Date().toISOString(),
              },
              {
                id: 'm2',
                conversationId: 'c1',
                role: 'assistant',
                content: 'Refunds take five days.',
                citations: [],
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/me/preferences') {
        return new Response(JSON.stringify(preferences), { status: 200 });
      }
      return fallback(url, init);
    }) as unknown as typeof fetch;

    const view = render(<App />);
    await userEvent.type(
      await screen.findByLabelText('Ask TriageAI anything'),
      'How long do refunds take?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Refunds take five days.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe('?c=c1'));

    view.unmount();
    render(<App />);

    expect(await screen.findByText('How long do refunds take?')).toBeInTheDocument();
    expect(screen.getAllByText('Refunds take five days.').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Show conversation history' }));
    expect(await screen.findByRole('button', { name: /^Refund policy/ })).toBeInTheDocument();
  });

  it('redirects /chat to the home conversation and selects the Chat tab', async () => {
    window.history.pushState({}, '', '/chat');
    mockManifest(['chat']);
    render(<App />);

    expect(await screen.findByLabelText('Ask TriageAI anything')).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
  });

  it('redirects /chat/:id to the matching home conversation', async () => {
    window.history.pushState({}, '', '/chat/c7');
    mockManifest(['chat']);
    const fallback = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).getMockImplementation() as typeof fetch;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/chat/conversations/c7') {
        return new Response(
          JSON.stringify({
            conversationId: 'c7',
            messages: [
              {
                id: 'm7',
                conversationId: 'c7',
                role: 'assistant',
                content: 'Earlier answer.',
                citations: [],
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/chat/conversations') {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      return fallback(url, init);
    }) as unknown as typeof fetch;

    render(<App />);

    expect(await screen.findByText('Earlier answer.')).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(window.location.search).toBe('?c=c7');
  });

  it('remembers the sidebar toggle per user', async () => {
    mockManifest(['chat']);
    const fallback = (
      globalThis.fetch as ReturnType<typeof vi.fn>
    ).getMockImplementation() as typeof fetch;
    let savedSidebar: unknown;
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/chat/conversations') {
        return new Response(JSON.stringify({ conversations: [] }), { status: 200 });
      }
      if (url === '/api/v1/me/preferences' && init?.method === 'PUT') {
        savedSidebar = JSON.parse(String(init.body)).chatSidebar;
        return new Response(
          JSON.stringify({
            preferences: {
              theme: 'auto',
              fontSize: 'default',
              motion: 'auto',
              agents: [],
              chatSidebar: true,
            },
            defaults: null,
            agents: [],
          }),
          { status: 200 },
        );
      }
      if (url === '/api/v1/me/preferences') {
        return new Response(
          JSON.stringify({
            preferences: {
              theme: 'auto',
              fontSize: 'default',
              motion: 'auto',
              agents: [],
              chatSidebar: false,
            },
            defaults: null,
            agents: [],
          }),
          { status: 200 },
        );
      }
      return fallback(url, init);
    }) as unknown as typeof fetch;

    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Show conversation history' }));
    expect(await screen.findByText('No conversations yet.')).toBeInTheDocument();
    expect(savedSidebar).toBe(true);
  });

  it('keeps the draft on home when chat is disabled', async () => {
    mockManifest(['echo']);
    render(<App />);

    const input = await screen.findByLabelText('Ask TriageAI anything');
    await userEvent.type(input, 'Hello?');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Chat is not enabled in this configuration.',
    );
    expect(window.location.pathname).toBe('/');
    expect(input).toHaveValue('Hello?');
  });
});
