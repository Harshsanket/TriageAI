import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FeedbackPage from './FeedbackPage';

const candidate = {
  id: 'c1',
  source: 'correction',
  status: 'proposed',
  input: { subject: 'refund' },
  gold: { category: 'billing' },
  provenance: { method: 'mistake' },
  createdAt: new Date().toISOString(),
};

const dataset = {
  id: 'd1',
  version: 'v1',
  purpose: 'classifier',
  sha256: 'abcdef0123456789',
  counts: { train: 4, val: 1, test: 1 },
  createdAt: new Date().toISOString(),
};

const models = [
  {
    id: 'm1',
    component: 'classifier',
    name: 'baseline',
    status: 'active',
    evalReportId: 'r1',
    evalReport: { passes: true, metrics: { macroF1: 0.8 } },
  },
  {
    id: 'm2',
    component: 'classifier',
    name: 'candidate',
    status: 'candidate',
    evalReportId: 'r2',
    evalReport: { passes: true, metrics: { macroF1: 0.82 } },
  },
];

function mockApi() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('/api/v1/system/candidates') && method === 'PATCH') {
      return new Response(JSON.stringify({ ...candidate, status: 'approved' }), { status: 200 });
    }
    if (url.includes('/api/v1/system/candidates')) {
      return new Response(JSON.stringify([candidate]), { status: 200 });
    }
    if (url.includes('/api/v1/datasets') && method === 'POST') {
      return new Response(JSON.stringify(dataset), { status: 201 });
    }
    if (url.includes('/api/v1/datasets')) {
      return new Response(JSON.stringify([dataset]), { status: 200 });
    }
    if (url.includes('/api/v1/models') && method === 'POST') {
      return new Response(JSON.stringify({ ...models[1], status: 'active' }), { status: 200 });
    }
    if (url.includes('/api/v1/models')) {
      return new Response(JSON.stringify(models), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('feedback loop page', () => {
  it('approves a candidate correction with the selected method', async () => {
    const fetchMock = mockApi();
    render(<FeedbackPage />);
    await screen.findByText('correction');
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const patch = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/api/v1/system/candidates/c1') &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );
    expect(patch).toBeTruthy();
    expect(String((patch?.[1] as RequestInit).body)).toContain('"status":"approved"');
    expect(String((patch?.[1] as RequestInit).body)).toContain('"method":"mistake"');
  });

  it('builds a dataset and promotes a candidate model', async () => {
    const fetchMock = mockApi();
    render(<FeedbackPage />);
    await screen.findByText('v1');
    await userEvent.click(screen.getByRole('button', { name: 'Build dataset from approved' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Promote' }));

    const build = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/v1/datasets') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    const promote = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes('/api/v1/models/m2/promote') &&
        (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(build).toBeTruthy();
    expect(promote).toBeTruthy();
  });
});
