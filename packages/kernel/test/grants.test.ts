import { describe, expect, it } from 'vitest';

import {
  diffPermissions,
  GrantsEngine,
  normalizePermissions,
  permissionHash,
} from '../src/grants.js';

const manifest = {
  routes: [{ method: 'GET' as const, path: '/api/v1/demo/runs' }],
  events: { publish: ['demo.changed'], subscribe: ['other.ready'] },
  capabilities: { consume: ['embedder'], provide: [] },
  stages: ['demo.run'],
  workflows: ['demo.workflow'],
  tools: [],
  knowledge: { read: ['demo_docs'], write: [] },
};

describe('module grants (ADR-0054 §2)', () => {
  it('allows declared resources and blocks everything else', () => {
    const denials: string[] = [];
    const grants = new GrantsEngine('demo', manifest, (resource, name) =>
      denials.push(`${resource}:${name}`),
    );

    expect(() => grants.assertRoute('GET', '/api/v1/demo/runs')).not.toThrow();
    expect(() => grants.assertStage('demo.run')).not.toThrow();
    expect(() => grants.assertWorkflow('demo.workflow')).not.toThrow();
    expect(() => grants.assertKnowledge('demo_docs', 'read')).not.toThrow();

    expect(() => grants.assertRoute('POST', '/api/v1/demo/runs')).toThrowError(
      /kernel\.POLICY_BLOCKED|not granted/,
    );
    expect(() => grants.assertCapabilityConsume('classifier')).toThrow();
    expect(() => grants.assertKnowledge('other_docs', 'read')).toThrow();
    expect(denials).toEqual([
      'route:POST /api/v1/demo/runs',
      'capability.consume:classifier',
      'knowledge.read:other_docs',
    ]);
  });

  it('refuses to publish outside the module namespace, even when listed', () => {
    const grants = new GrantsEngine('chat', {
      ...manifest,
      events: { publish: ['support.ticket.created'], subscribe: [] },
    });
    expect(() => grants.assertEventPublish('support.ticket.created')).toThrowError(
      /namespace is chat\.\*/,
    );
    expect(() => grants.assertEventPublish('chat.replied')).toThrow();
  });

  it('defaults to deny for third-party modules without a manifest', () => {
    const grants = new GrantsEngine('plugin', undefined, undefined, false);
    expect(() => grants.assertRoute('GET', '/api/v1/plugin')).toThrow();
    const trusted = new GrantsEngine('first-party', undefined, undefined, true);
    expect(() => trusted.assertRoute('GET', '/api/v1/first-party')).not.toThrow();
  });

  it('hashes the manifest independently of array order and reports a widening diff', () => {
    const left = normalizePermissions({
      ...manifest,
      stages: ['demo.run', 'demo.other'],
    });
    const reordered = normalizePermissions({
      ...manifest,
      stages: ['demo.other', 'demo.run'],
    });
    expect(permissionHash(left)).toBe(permissionHash(reordered));

    const widened = normalizePermissions({
      ...manifest,
      stages: ['demo.run', 'demo.other'],
      routes: [...manifest.routes, { method: 'POST' as const, path: '/api/v1/demo/runs' }],
    });
    const diff = diffPermissions('demo', '1.0.0', '1.1.0', left, widened);
    expect(diff.added).toEqual(['route:POST /api/v1/demo/runs']);
    expect(diff.removed).toEqual([]);
  });
});
