import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelRuntimePanel } from './ConfigPage';

const runtimes = [
  {
    id: 'ollama:qwen',
    adapter: 'ollama',
    model: 'qwen',
    baseUrl: null,
    hosted: false,
    contextWindow: 8192,
    maxOutput: 1024,
    features: ['chat'],
    status: 'ready',
    enabled: true,
    source: 'config',
    lastCheckAt: null,
  },
  {
    id: 'lmstudio:local',
    adapter: 'lmstudio',
    model: 'local',
    baseUrl: null,
    hosted: false,
    contextWindow: 8192,
    maxOutput: 1024,
    features: ['chat'],
    status: 'ready',
    enabled: true,
    source: 'config',
    lastCheckAt: null,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('model runtime switches (phase 32)', () => {
  it('renders toggles and engages the global switch when the last runtime is turned off', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    let controls = { llmDisabled: false, disabledRuntimes: [] as string[] };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/api/v1/system/controls') && init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as Partial<typeof controls>;
          calls.push({ url: String(url), body: String(init.body) });
          controls = { ...controls, ...body };
          return Response.json(controls);
        }
        return Response.json({ runtimes, controls });
      }),
    );
    render(<ModelRuntimePanel />);
    expect(await screen.findByRole('switch', { name: 'Turn off all LLMs' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'ollama:qwen enabled' }));
    await userEvent.click(screen.getByRole('switch', { name: 'lmstudio:local enabled' }));
    await waitFor(() => {
      const last = calls.at(-1);
      expect(last?.body).toContain('"llmDisabled":true');
    });
  });
});
