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
    expect(cfg.modules.kb?.enabled).toBe(true);
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

  it('loadConfigFile fails when an explicit path is missing', () => {
    expect(() => loadConfigFile('nope/missing.json')).toThrow(/not found/);
  });

  it('loadConfigFile resolves an explicit preset path from the repo root', () => {
    // Workspace scripts run in packages/*, two levels below the root.
    const cfg = loadConfigFile('config/presets/support.json');
    expect(cfg.profile).toBe('support');
  });

  it('defaults retention windows to disabled/null', () => {
    const cfg = buildKernelConfig(parseConfigFile({}), {});
    expect(cfg.retention).toEqual({
      enabled: false,
      intervalHours: 24,
      runDays: null,
      decisionDays: null,
      auditDays: null,
      candidateDays: null,
      messageDays: null,
      deadletterDays: null,
    });
  });

  it('validates per-profile retention windows', () => {
    const cfg = buildKernelConfig(
      parseConfigFile({
        retention: { enabled: true, runDays: 30, decisionDays: 7, messageDays: 14 },
      }),
      {},
    );
    expect(cfg.retention).toMatchObject({
      enabled: true,
      runDays: 30,
      decisionDays: 7,
      messageDays: 14,
    });
    expect(() => parseConfigFile({ retention: { runDays: 0 } })).toThrow(
      /Invalid triage.config.json/,
    );
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
