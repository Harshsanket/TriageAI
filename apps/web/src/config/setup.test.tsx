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
    expect(screen.queryByRole('button', { name: 'Runs' })).not.toBeInTheDocument();
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

    expect(await screen.findByRole('radio', { name: /Ollama/ })).toBeChecked();
    expect(screen.getByRole('textbox', { name: /Model \(as the runtime names it\)/ })).toHaveValue(
      'qwen2.5:3b',
    );
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
    for (let i = 0; i < 5; i += 1) {
      await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    }

    expect(await screen.findByRole('heading', { name: 'Review & apply' })).toBeInTheDocument();
    expect(await screen.findByText('Fix these before applying:')).toBeInTheDocument();
    expect(screen.getByText(/Sign-in needs a JWT secret/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply setup' })).toBeDisabled();
  });
});
