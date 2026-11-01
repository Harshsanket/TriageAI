import { describe, expect, it } from 'vitest';

import { CapabilityRouter } from '../src/capabilityRouter.js';
import type { Capabilities, KernelConfig } from '../src/types.js';

const config = (capabilities: KernelConfig['capabilities'] = {}): KernelConfig => ({
  profile: 'test',
  queue: { adapter: 'inline' },
  modules: {},
  capabilities,
});

describe('capability router (ADR-0054 §4)', () => {
  it('serves the built-in adapter by default', () => {
    const builtIn: Capabilities = {
      classifier: {
        classify: async () => ({
          category: 'billing',
          confidence: 1,
          margin: 1,
          method: 'zero-shot',
          modelVersion: 'test',
          scores: [],
        }),
      },
    };
    const router = new CapabilityRouter(config(), builtIn);
    expect(router.resolve('classifier')).toBe(builtIn.classifier);
    expect(router.providerOf('classifier')?.provider).toBe('built-in');
  });

  it('lets a module provide a capability, selected by config', () => {
    const builtIn: Capabilities = {
      embedder: { embed: async () => ({ vectors: [[0.1]], modelVersion: 'test' }) },
    };
    const provided = { embed: async () => ({ vectors: [] }) };
    const router = new CapabilityRouter(
      config({ embedder: { adapter: 'module', provider: 'provider-module' } }),
      builtIn,
    );
    router.provide('provider-module', 'embedder', provided);
    expect(router.resolve('embedder')).toBe(provided);
    expect(router.providerOf('embedder')).toMatchObject({
      provider: 'provider-module',
      moduleId: 'provider-module',
    });
    expect(router.snapshot().embedder?.moduleId).toBe('provider-module');
  });

  it('returns undefined when the configured provider is not registered', () => {
    const router = new CapabilityRouter(
      config({ classifier: { adapter: 'module', provider: 'missing' } }),
      {
        classifier: {
          classify: async () => ({
            category: 'billing',
            confidence: 1,
            margin: 1,
            method: 'zero-shot',
            modelVersion: 'test',
            scores: [],
          }),
        },
      },
    );
    expect(router.resolve('classifier')).toBeUndefined();
  });
});
