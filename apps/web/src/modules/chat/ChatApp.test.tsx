import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import ChatApp from './ChatApp';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chat data-policy flag (phase 19.T6)', () => {
  it('posts the assistant message run id to the audited flag endpoint', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init: init ?? undefined });
      if (url === '/api/v1/me/preferences') return json({ agents: [] });
      if (url === '/api/v1/chat/conversations/c1') {
        return json({
          messages: [
            {
              id: 'm2',
              role: 'assistant',
              content: 'Grounded answer',
              citations: [],
              runId: 'run-flag-1',
              createdAt: new Date().toISOString(),
            },
          ],
          context: null,
        });
      }
      if (url.startsWith('/api/v1/chat/conversations')) return json({ conversations: [] });
      return json({ runId: 'run-flag-1', flagged: true });
    });

    render(<ChatApp initialConversationId="c1" showSidebar={false} />);
    await userEvent.click(await screen.findByRole('button', { name: 'flag answer m2' }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === '/api/v1/system/runs/run-flag-1/flag' && call.init?.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(await screen.findByText('Flagged for review')).toBeInTheDocument();
  });

  it('does not render a flag button for answers without a run id', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/v1/me/preferences') return json({ agents: [] });
      if (url === '/api/v1/chat/conversations/c1') {
        return json({
          messages: [
            {
              id: 'm3',
              role: 'assistant',
              content: 'Legacy answer',
              citations: [],
              createdAt: new Date().toISOString(),
            },
          ],
          context: null,
        });
      }
      return json({ conversations: [] });
    });

    render(<ChatApp initialConversationId="c1" showSidebar={false} />);
    expect(await screen.findByText('Legacy answer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /flag answer/i })).not.toBeInTheDocument();
  });
});

describe('chat streaming (phase 13.5)', () => {
  it('uses the SSE endpoint and renders the validated message without polling', async () => {
    const calls: string[] = [];
    const frame = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            frame('status', { conversationId: 'c1', runId: 'r1', state: 'thinking' }) +
              frame('message', {
                id: 'm2',
                role: 'assistant',
                content: 'Streamed answer',
                citations: [],
                createdAt: new Date().toISOString(),
              }) +
              frame('done', { conversationId: 'c1', runId: 'r1' }),
          ),
        );
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url === '/api/v1/me/preferences') return json({ agents: [] });
      if (url.startsWith('/api/v1/chat/conversations/') && !url.includes('stream')) {
        return json({
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'Hello?',
              citations: [],
              createdAt: new Date().toISOString(),
            },
            {
              id: 'm2',
              role: 'assistant',
              content: 'Streamed answer',
              citations: [],
              createdAt: new Date().toISOString(),
            },
          ],
          context: null,
        });
      }
      if (url.startsWith('/api/v1/chat/conversations')) return json({ conversations: [] });
      if (url === '/api/v1/chat/stream') {
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return json({});
    });

    render(<ChatApp showSidebar={false} />);
    await userEvent.type(screen.getByLabelText('chat message'), 'Hello?');
    await userEvent.click(screen.getByLabelText('Send message'));

    await waitFor(() => expect(screen.getByText('Streamed answer')).toBeInTheDocument());
    expect(screen.getByLabelText('Context usage not measured yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
    expect(calls).toContain('/api/v1/chat/stream');
    expect(calls.filter((url) => url === '/api/v1/chat/messages')).toHaveLength(0);
  });
});
