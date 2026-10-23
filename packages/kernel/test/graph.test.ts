import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { resolveModules } from '../src/kernel.js';
import type { TriageModule, ModuleManifest } from '../src/types.js';

const emptyManifest: ModuleManifest = { routes: [], nav: [], background: [] };

function fakeModule(
  id: string,
  version: string,
  dependsOn: TriageModule['dependsOn'],
): TriageModule {
  return {
    id,
    version,
    capabilities: [],
    dependsOn,
    manifest: emptyManifest,
    lifecycle: {},
    register: () => undefined,
  };
}

describe('resolveModules', () => {
  const config = (ids: string[]) => ({
    profile: 'core',
    queue: { adapter: 'inline' as const },
    modules: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
    capabilities: {},
  });

  it('orders dependencies before dependents', () => {
    const modules = {
      a: fakeModule('a', '0.1.0', { modules: [{ id: 'b', version: '^0.1.0' }] }),
      b: fakeModule('b', '0.2.0', {}),
    };
    const res = resolveModules(config(['a', 'b']), modules);
    expect(res.error).toBeUndefined();
    expect(res.ordered.map((r) => r.module.id)).toEqual(['b', 'a']);
  });

  it('reports missing module registrations with precise names', () => {
    const res = resolveModules(config(['ghost']), {});
    expect(res.error).toEqual([
      'module "ghost" is enabled in config but not registered (is the module installed and imported into the host?)',
    ]);
  });

  it('reports disabled-but-required dependencies', () => {
    const modules = {
      a: fakeModule('a', '0.1.0', { modules: [{ id: 'b', version: '>=0.1.0' }] }),
      b: fakeModule('b', '0.2.0', {}),
    };
    const res = resolveModules(config(['a']), modules);
    expect(res.error?.[0]).toContain('depends on "b" which is registered but not enabled');
  });

  it('enforces version ranges', () => {
    const modules = {
      a: fakeModule('a', '0.1.0', { modules: [{ id: 'b', version: '^0.2.0' }] }),
      b: fakeModule('b', '0.1.0', {}),
    };
    const res = resolveModules(config(['a', 'b']), modules);
    expect(res.error?.[0]).toContain('0.1.0 < 0.2.0 within same major');
  });

  it('detects cycles, naming the loop', () => {
    const modules = {
      a: fakeModule('a', '0.1.0', { modules: [{ id: 'b', version: '^0.1.0' }] }),
      b: fakeModule('b', '0.1.0', { modules: [{ id: 'a', version: '^0.1.0' }] }),
    };
    const res = resolveModules(config(['a', 'b']), modules);
    expect(res.error?.[0]).toMatch(/cycle detected: a → b → a|cycle detected: b → a → b/);
  });
});

describe('ulid ids', () => {
  it('are unique', () => {
    expect(ulid()).not.toEqual(ulid());
  });
});
