import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';
import { OfflineBanner, useOnline } from './OfflineBanner';
import { ErrorNotice, safeExternalUrl } from './index';
import KbApp from '../modules/kb/KbApp';

function Boom(): never {
  throw new Error('module exploded');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('web error handling (phase 10c)', () => {
  it('keeps the shell usable when a page crashes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <nav>Shell nav</nav>
        <ErrorBoundary label="Chat">
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText('Shell nav')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Chat hit an unexpected error/);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  });

  it('shows the safe user message and correlation id, and can be dismissed', async () => {
    render(
      <ErrorNotice
        error={{
          status: 503,
          envelope: {
            type: 'https://triageai.dev/errors/x',
            title: 'x',
            status: 503,
            code: 'ai.UNAVAILABLE',
            category: 'dependency_unavailable',
            retryable: true,
            userMessage: 'The AI service is unavailable.',
            correlationId: 'req-42',
          },
        }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('The AI service is unavailable.');
    expect(screen.getByRole('alert')).toHaveTextContent('req-42');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows offline and online states', async () => {
    function Probe() {
      return <span>{useOnline() ? 'online' : 'offline'}</span>;
    }
    render(
      <>
        <OfflineBanner />
        <Probe />
      </>,
    );
    globalThis.dispatchEvent(new Event('offline'));
    expect(await screen.findByText('offline')).toBeInTheDocument();
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    globalThis.dispatchEvent(new Event('online'));
    expect(await screen.findByText('online')).toBeInTheDocument();
  });

  it('shows a failed request as an error, never as an empty list', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: 'https://triageai.dev/errors/INTERNAL_ERROR',
            title: 'INTERNAL_ERROR',
            status: 500,
            code: 'INTERNAL_ERROR',
            category: 'internal',
            retryable: false,
            userMessage: 'The knowledge base could not be read.',
            correlationId: 'req-9',
          }),
          { status: 500 },
        ),
    ) as unknown as typeof fetch;

    render(<KbApp />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The knowledge base could not be read.',
    );
    expect(screen.queryByText(/No documents yet/)).not.toBeInTheDocument();
  });
});

describe('external links (phase 21)', () => {
  it('only allows http(s) URLs', () => {
    expect(safeExternalUrl('https://github.com/acme/repo')).toBe('https://github.com/acme/repo');
    expect(safeExternalUrl('http://example.com/x')).toBe('http://example.com/x');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<script>')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});
