import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActiveModelAsset, ModelRegistry } from '@triageai/kernel';

import { HttpClassifier } from '../src/platform/capabilities.js';

function registry(asset: ActiveModelAsset | null): ModelRegistry {
  return { active: async () => asset };
}

const response = {
  category: 'billing',
  confidence: 0.91,
  margin: 0.3,
  method: 'trained',
  modelVersion: 'linear-probe-v1',
  scores: [{ category: 'billing', score: 0.91 }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trained classifier adapter (phase 7)', () => {
  it('forwards the active linear-probe pointer to the ai-service', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const classifier = new HttpClassifier(
      'http://ai',
      registry({
        id: 'asset-1',
        component: 'classifier',
        name: 'probe-v1',
        artifactRef: 'linear-probe-v1',
        config: { kind: 'linear-probe' },
        evalReportId: 'report-1',
        promotedAt: '2026-01-01T00:00:00Z',
      }),
    );
    const result = await classifier.classify('invoice please');
    expect(result.method).toBe('trained');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'invoice please',
      model: { name: 'probe-v1', artifactRef: 'linear-probe-v1', kind: 'linear-probe' },
    });
  });

  it('uses the default backend when no trained asset is active', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const classifier = new HttpClassifier('http://ai', registry(null));
    await classifier.classify('invoice please');
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ text: 'invoice please' });
  });
});
