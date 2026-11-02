import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import KbApp from './KbApp';

const storage = {
  totalBytes: 1000,
  originalsBytes: 400,
  textBytes: 300,
  chunksBytes: 200,
  vectorBytes: 100,
  documents: 2,
  chunks: 8,
  sources: [],
  backends: [
    { label: 'Database', value: 'PostgreSQL' },
    { label: 'Vectors', value: 'pgvector (PostgreSQL)' },
    { label: 'Queue', value: 'PostgreSQL (pg-queue)' },
    { label: 'Files', value: 'Blob store' },
  ],
  processing: {
    chunkStrategies: [{ label: 'structure-700', value: 2 }],
    ingestStatus: [
      { label: 'succeeded', value: 3 },
      { label: 'failed', value: 1 },
    ],
    accessModes: [{ label: 'Editable', value: 2 }],
    mediaTypes: [{ label: 'application/pdf', value: 1 }],
    contextualChunks: 6,
    totalChunks: 8,
    contextualRate: 75,
    errorRate: 25,
    pdfExtraction: 'deterministic text layer (no OCR)',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

const source = {
  id: 's1',
  title: 'Handbook',
  kind: 'file',
  label: 'Docs',
  uri: null,
  mediaType: 'text/markdown',
  contentHash: 'abc',
  enabled: true,
  status: 'ready',
  itemCount: 3,
  sizeBytes: 120,
  sensitivity: 'internal',
  audience: 'public',
  managedKey: null,
  readOnly: false,
  chunkPreset: 'structure-700',
  extraction: 'direct',
  storage: ['PostgreSQL', 'Blob store', 'pgvector'],
  modelUse: 'redact',
  retentionDays: null,
  lastSyncAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('knowledge processing metrics (phase 30.1)', () => {
  it('shows the data-processing section with the metric graph', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).startsWith('/api/v1/kb/sources')) {
          return Response.json({ sources: [] });
        }
        return Response.json(storage);
      }),
    );
    render(<KbApp />);
    expect(await screen.findByText('Data processing')).toBeInTheDocument();
    expect(screen.getByText('75% (6 / 8 chunks)')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('deterministic text layer (no OCR)')).toBeInTheDocument();
    expect(screen.getByLabelText('Chunking strategy')).toBeInTheDocument();
    expect(screen.getByLabelText('Ingest outcomes')).toBeInTheDocument();
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('pgvector (PostgreSQL)')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL (pg-queue)')).toBeInTheDocument();
  });

  it('replaces the items column with per-source model use and retention controls', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith('/api/v1/kb/sources/') && init?.method === 'PATCH') {
          calls.push({ url: String(url), body: String(init.body) });
          return Response.json({ source });
        }
        if (String(url).startsWith('/api/v1/kb/sources/') && init?.method === 'DELETE') {
          calls.push({ url: String(url), body: 'DELETE' });
          return Response.json({ deleted: true });
        }
        if (String(url).startsWith('/api/v1/kb/sources')) {
          return Response.json({ sources: [source] });
        }
        return Response.json(storage);
      }),
    );
    render(<KbApp />);
    expect(await screen.findByText('Handbook')).toBeInTheDocument();
    expect(screen.getByText('Chunks: structure 700')).toBeInTheDocument();
    expect(screen.getByText('Extract: direct decode')).toBeInTheDocument();
    expect(screen.getAllByText('PostgreSQL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Blob store').length).toBeGreaterThan(0);
    expect(screen.getAllByText('pgvector').length).toBeGreaterThan(0);
    expect(screen.queryByRole('columnheader', { name: 'Items' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Unlimited').length).toBeGreaterThan(0);
    const use = screen.getByLabelText('Handbook model use');
    expect(use).toHaveValue('redact');
    expect(screen.getByRole('option', { name: 'Full access' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Allowed' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Never' })).not.toBeInTheDocument();
    await userEvent.selectOptions(use, 'withhold');
    await waitFor(() => expect(calls.at(-1)?.body).toContain('"modelUse":"withhold"'));
    const retention = screen.getByLabelText('Handbook retention');
    await userEvent.selectOptions(retention, '90');
    await waitFor(() => expect(calls.at(-1)?.body).toContain('"retentionDays":90'));

    expect(screen.getByText('Delete sources')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete sources' }));
    expect(screen.getByText(/Delete mode/)).toBeInTheDocument();
    vi.stubGlobal('confirm', () => true);
    await userEvent.click(screen.getByRole('button', { name: 'Delete Handbook' }));
    await waitFor(() => expect(calls.some((call) => call.body === 'DELETE')).toBe(true));
  });

  it('labels host-maintained sources clearly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).startsWith('/api/v1/kb/sources')) {
          return Response.json({
            sources: [
              {
                ...source,
                id: 'managed-1',
                managedKey: 'base-memory.public',
                readOnly: true,
              },
            ],
          });
        }
        return Response.json(storage);
      }),
    );
    render(<KbApp />);
    expect(await screen.findByText('Host-maintained')).toBeInTheDocument();
    expect(screen.queryByText('Managed')).not.toBeInTheDocument();
  });
});
