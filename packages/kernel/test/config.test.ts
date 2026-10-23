import { describe, expect, it } from 'vitest';

import { buildKernelConfig, loadConfigFile, parseConfigFile } from '../src/config.js';
import { satisfiesRange } from '../src/semver.js';

describe('config', () => {
  it('rejects unknown queue adapters', () => {
    expect(() => parseConfigFile({ queue: { adapter: 'kafka' } })).toThrow(
      /Invalid triage.config.json/,
    );
  });

  it('applies profile presets under explicit module config', () => {
    const file = parseConfigFile({
      profile: 'assistant',
      modules: { chat: { enabled: true } },
    });
    const cfg = buildKernelConfig(file, {});
    expect(cfg.modules.chat?.enabled).toBe(true);
    expect(cfg.modules.memory?.enabled).toBe(true);
    expect(cfg.modules.support).toBeUndefined();
  });

  it('env overrides enable/disable modules', () => {
    const file = parseConfigFile({ profile: 'core' });
    const cfg = buildKernelConfig(file, {
      TRIAGEAI_ENABLE_MODULES: 'echo',
      TRIAGEAI_DISABLE_MODULES: 'echo',
    });
    expect(cfg.modules.echo?.enabled).toBe(false);
  });

  it('env selects the inline queue adapter', () => {
    const file = parseConfigFile({});
    const cfg = buildKernelConfig(file, { TRIAGEAI_QUEUE_ADAPTER: 'inline' });
    expect(cfg.queue.adapter).toBe('inline');
  });

  it('loadConfigFile defaults quietly when missing', () => {
    const cfg = loadConfigFile('nope/missing.json');
    expect(cfg.profile).toBe('core');
  });
});

describe('semver subset', () => {
  it('requires exact match for bare versions', () => {
    expect(satisfiesRange('1.2.3', '1.2.3').ok).toBe(true);
    expect(satisfiesRange('1.2.4', '1.2.3').ok).toBe(false);
  });
  it('honors >= ranges', () => {
    expect(satisfiesRange('1.3.0', '>=1.2.3').ok).toBe(true);
    expect(satisfiesRange('1.1.0', '>=1.2.3').ok).toBe(false);
  });
  it('honors ^ ranges within the major', () => {
    expect(satisfiesRange('1.9.9', '^1.2.0').ok).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.0').ok).toBe(false);
  });
});
