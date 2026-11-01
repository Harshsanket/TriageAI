import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';

import { resolveModules } from '../src/kernel.js';
import { normalizePermissions } from '../src/grants.js';
import type { TriageModule, ModuleManifest } from '../src/types.js';

const emptyManifest: ModuleManifest = { routes: [], nav: [], background: [] };

function fakeModule(
  id: string,
  version: string,
  provides: string[] = [],
  consumes: string[] = [],
): TriageModule {
  return {
    id,
    version,
    capabilities: [],
    permissions: normalizePermissions({
      capabilities: { consume: consumes, provide: provides },
    }),
    dependsOn: { capabilities: [] },
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

  it('orders capability providers before consumers', () => {
    const modules = {
      a: fakeModule('a', '0.1.0', [], ['search']),
      b: fakeModule('b', '0.2.0', ['search'], []),
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

  it('detects handler cycles, naming the loop', () => {
    const modules = {
      a: fakeModule('a', '0.1.0', ['cap-a'], ['cap-b']),
      b: fakeModule('b', '0.1.0', ['cap-b'], ['cap-a']),
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
