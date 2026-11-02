import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HardwareProfile, SetupStatus } from '@triageai/contracts';

import { App } from '../App';
import { ConfigView } from './ConfigPage';
import { Wizard } from './Wizard';

const PENDING: SetupStatus = {
  state: 'pending',
  tokenRequired: true,
  restartRequired: false,
  lastError: null,
  overlayVersion: null,
  secretStoreAvailable: true,
};

const COMPLETE: SetupStatus = {
  ...PENDING,
  state: 'complete',
  tokenRequired: false,
  overlayVersion: 1,
};

const HARDWARE: HardwareProfile = {
  platform: 'darwin',
  arch: 'arm64',
  cpuModel: 'Apple M2',
  cpuCores: 8,
  memoryTotalBytes: 16 * 1024 ** 3,
  memoryFreeBytes: 8 * 1024 ** 3,
  appleSilicon: true,
  gpu: null,
  diskFreeBytes: 200 * 1024 ** 3,
  modelBudgetBytes: 10 * 1024 ** 3,
  tier: 'medium',
  services: { aiService: true, ollama: true },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.pushState({}, '', '/');
});

describe('first-run gate', () => {
  it('renders the wizard instead of the app shell while setup is pending', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/v1/setup/status') return json(PENDING);
      return json({});
    }) as unknown as typeof fetch;

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Setup token' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/config');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'TriageAI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Runs' })).not.toBeInTheDocument();
  });

  it('shows only setup while the setup status is still loading', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/v1/setup/status') return new Promise<Response>(() => undefined);
      if (url.includes('/api/v1/system/manifest')) {
        return json({
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
        });
      }
      return json({});
    }) as unknown as typeof fetch;

    render(<App />);

    expect(await screen.findByText('Loading setup…')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Echo' })).not.toBeInTheDocument();
  });
});

describe('setup token step', () => {
  it('rejects a bad token and continues with a good one', async () => {
    const seen: Array<string | null> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/v1/setup/draft') {
        const auth = new Headers(init?.headers).get('authorization');
        seen.push(auth);
        return auth === 'Setup good-token'
          ? json({ draft: {} })
          : json({ detail: 'bad token' }, 401);
      }
      if (url === '/api/v1/setup/hardware') return json(HARDWARE);
      return json({});
    }) as unknown as typeof fetch;

    render(<Wizard status={PENDING} onApplied={() => undefined} />);

    const input = screen.getByRole('textbox', { name: 'Setup token' });
    await userEvent.type(input, 'wrong-token');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted');
    expect(sessionStorage.getItem('triageai.setupToken')).toBeNull();

    await userEvent.clear(input);
    await userEvent.type(input, 'good-token');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Machine check' })).toBeInTheDocument();
    expect(seen).toContain('Setup wrong-token');
    expect(seen).toContain('Setup good-token');
  });
});

describe('changing setup after it is complete', () => {
  it('pre-fills the wizard from the running config', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/v1/setup/config/effective') {
        return json({
          bootedOverlayVersion: 1,
          latestOverlay: null,
          history: [],
          running: {
            profile: 'support',
            modules: {
              chat: { enabled: true },
              support: { enabled: true },
              kb: { enabled: true },
              'integrations-github': { enabled: true, options: { repo: 'acme/help' } },
              echo: { enabled: false },
            },
            capabilities: {
              generator: {
                adapter: 'ollama',
                baseUrl: 'http://localhost:11434',
                model: 'qwen2.5:3b',
              },
            },
          },
          authMode: 'required',
          authModeSource: 'setting',
        });
      }
      if (url === '/api/v1/setup/secrets') return json({ available: true, secrets: [] });
      if (url === '/api/v1/setup/hardware') return json(HARDWARE);
      if (url.startsWith('/api/v1/setup/models')) return json({ models: [] });
      return json({});
    }) as unknown as typeof fetch;

    render(<ConfigView status={COMPLETE} refresh={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Change setup' }));

    expect(await screen.findByRole('heading', { name: 'Machine check' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('checkbox', { name: /Chatbot/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Ticket solver/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /GitHub issues/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Doc assistant/ })).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('radio', { name: /Ollama/ })).toBeChecked();
    expect(screen.getByRole('textbox', { name: /Model \(as the runtime names it\)/ })).toHaveValue(
      'qwen2.5:3b',
    );
  });
});

describe('module switches', () => {
  it('stages additions and switches into delete mode when an enabled module is switched off', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/v1/setup/config/effective') {
        return json({
          bootedOverlayVersion: 1,
          latestOverlay: { version: 1, overlay: { interfaces: ['chatbot'] } },
          history: [],
          running: { profile: 'assistant', modules: { chat: { enabled: true } }, capabilities: {} },
          authMode: 'disabled',
          authModeSource: 'setting',
        });
      }
      if (url === '/api/v1/setup/secrets') return json({ available: true, secrets: [] });
      return json({});
    }) as unknown as typeof fetch;

    render(<ConfigView status={COMPLETE} refresh={() => undefined} />);

    const emailer = await screen.findByRole('switch', { name: 'emailer' });
    expect(emailer).not.toBeChecked();
    await userEvent.click(emailer);
    expect(screen.getByText('will be added')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to setup' })).toBeEnabled();

    const chatbot = screen.getByRole('switch', { name: 'chatbot' });
    expect(chatbot).toBeChecked();
    await userEvent.click(chatbot);
    expect(screen.queryByRole('switch', { name: 'chatbot' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete chatbot' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('replaces switches with delete icons in remove mode', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/v1/setup/config/effective') {
        return json({
          bootedOverlayVersion: 1,
          latestOverlay: { version: 1, overlay: { interfaces: ['chatbot'] } },
          history: [],
          running: { profile: 'assistant', modules: { chat: { enabled: true } }, capabilities: {} },
          authMode: 'disabled',
          authModeSource: 'setting',
        });
      }
      if (url === '/api/v1/setup/secrets') return json({ available: true, secrets: [] });
      if (url === '/api/v1/setup/remove') return json({ removed: ['chatbot'] });
      return json({});
    }) as unknown as typeof fetch;

    render(<ConfigView status={COMPLETE} refresh={() => undefined} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Remove interfaces' }));
    expect(screen.queryByRole('switch', { name: 'chatbot' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete emailer' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Delete chatbot' }));
    expect(await screen.findByText('Removed chatbot.')).toBeInTheDocument();
    expect(calls).toEqual(
      expect.arrayContaining([{ url: '/api/v1/setup/remove', method: 'POST' }]),
    );
  });
});

describe('model settings and danger zone', () => {
  it('edits model settings and resets the overlay with typed confirmation', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === '/api/v1/setup/config/effective') {
        return json({
          bootedOverlayVersion: 1,
          latestOverlay: null,
          history: [],
          running: { profile: 'assistant', modules: {}, capabilities: {} },
          authMode: 'disabled',
          authModeSource: 'setting',
        });
      }
      if (url === '/api/v1/setup/secrets') return json({ available: true, secrets: [] });
      if (url === '/api/v1/system/data-policy') return json({ classes: [], sendGate: {} });
      if (url === '/api/v1/setup/model-settings' && (init?.method ?? 'GET') === 'GET') {
        return json({
          generator: {
            adapter: 'ollama',
            model: 'qwen2.5:1.5b',
            baseUrl: 'http://localhost:11434',
            temperature: 0.2,
            maxTokens: 384,
            timeoutMs: 120000,
          },
          chat: { maxAnswerTokens: 384 },
          retriever: { threshold: 0.35, margin: 0.05 },
          overlayVersion: 1,
          latestOverlayVersion: 1,
          restartRequired: false,
        });
      }
      if (url === '/api/v1/setup/model-settings') return json({ saved: true, version: 2 });
      if (url === '/api/v1/setup/restart') return json({ restarted: true });
      if (url === '/api/v1/setup/reset') return json({ reset: true, version: 3 });
      return json({});
    }) as unknown as typeof fetch;

    render(<ConfigView status={COMPLETE} refresh={() => undefined} />);
    expect(await screen.findByRole('heading', { name: 'Models' })).toBeInTheDocument();
    const temperature = screen.getByLabelText('Temperature');
    await userEvent.clear(temperature);
    await userEvent.type(temperature, '0.7');
    await userEvent.click(screen.getByRole('button', { name: 'Save model settings' }));
    expect(
      await screen.findByText('Saved. Restart the API to use the new model settings.'),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Restart API' }));
    expect(
      await screen.findByText('Restart requested. The API is restarting…'),
    ).toBeInTheDocument();

    const confirm = screen.getByLabelText('type RESET to confirm');
    await userEvent.type(confirm, 'RESET');
    await userEvent.click(screen.getByRole('button', { name: 'Reset configuration' }));
    expect(
      await screen.findByText('Configuration reset saved. Restart the API to apply defaults.'),
    ).toBeInTheDocument();
    expect(calls).toEqual(
      expect.arrayContaining([
        { url: '/api/v1/setup/model-settings', method: 'PUT' },
        { url: '/api/v1/setup/restart', method: 'POST' },
        { url: '/api/v1/setup/reset', method: 'POST' },
      ]),
    );
  });
});

describe('data processing settings', () => {
  it('saves manual chunking and extraction choices with strategy notes', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? String(init.body) : undefined,
      });
      if (url === '/api/v1/setup/config/effective') {
        return json({
          bootedOverlayVersion: 1,
          latestOverlay: null,
          history: [],
          running: { profile: 'assistant', modules: {}, capabilities: {} },
          authMode: 'disabled',
          authModeSource: 'setting',
        });
      }
      if (url === '/api/v1/setup/secrets') return json({ available: true, secrets: [] });
      if (url === '/api/v1/system/data-policy') return json({ classes: [], sendGate: {} });
      if (url === '/api/v1/system/data-processing') {
        return json({
          chunking: 'structure-700',
          pdfExtraction: 'text-layer',
          imageExtraction: 'skip',
        });
      }
      return json({});
    }) as unknown as typeof fetch;

    render(<ConfigView status={COMPLETE} refresh={() => undefined} />);

    expect(await screen.findByRole('heading', { name: 'Data processing' })).toBeInTheDocument();
    expect(screen.getAllByText(/Structure-aware · 700 chars/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Best for: Digital PDFs/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Chunking strategy'), 'sentence-500');
    await userEvent.click(screen.getByRole('button', { name: 'Save data processing' }));
    expect(await screen.findByText(/Saved\. New sources use these settings/)).toBeInTheDocument();
    const put = calls.find(
      (call) => call.url === '/api/v1/system/data-processing' && call.method === 'PUT',
    );
    expect(put?.body).toContain('"chunking":"sentence-500"');
  });
});

describe('review step', () => {
  it('shows plan problems and disables Apply', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === '/api/v1/setup/hardware') return json(HARDWARE);
      if (url.startsWith('/api/v1/setup/models')) return json({ models: [] });
      if (url === '/api/v1/setup/plan') {
        return json({
          overlay: { modules: { chat: { enabled: true } } },
          enabledModules: ['chat'],
          problems: ['Sign-in needs a JWT secret: set TRIAGEAI_SECRET_KEY.'],
          warnings: [],
          secrets: [],
        });
      }
      return json({});
    }) as unknown as typeof fetch;

    render(<Wizard status={{ ...PENDING, tokenRequired: false }} onApplied={() => undefined} />);

    await screen.findByRole('heading', { name: 'Machine check' });
    for (let i = 0; i < 6; i += 1) {
      await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    }

    expect(await screen.findByRole('heading', { name: 'Review & apply' })).toBeInTheDocument();
    expect(await screen.findByText('Fix these before applying:')).toBeInTheDocument();
    expect(screen.getByText(/Sign-in needs a JWT secret/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply setup' })).toBeDisabled();
  });
});

describe('agent naming step', () => {
  it('pre-fills NASA names and keeps a rename', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      calls.push(url);
      if (url === '/api/v1/setup/hardware') return json(HARDWARE);
      if (url.startsWith('/api/v1/setup/agent-defaults')) {
        return json({
          agents: [{ interface: 'chatbot', displayName: 'Voyager', color: '#3b6fd4' }],
        });
      }
      if (url.startsWith('/api/v1/setup/models')) return json({ models: [] });
      return json({});
    }) as unknown as typeof fetch;

    render(<Wizard status={{ ...PENDING, tokenRequired: false }} onApplied={() => undefined} />);
    await screen.findByRole('heading', { name: 'Machine check' });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'What should it do?' });
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Name your agents' })).toBeInTheDocument();
    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Voyager');
    await userEvent.clear(name);
    await userEvent.type(name, 'Odyssey');
    expect(name).toHaveValue('Odyssey');
    expect(calls.some((url) => url.startsWith('/api/v1/setup/agent-defaults'))).toBe(true);
  });
});
