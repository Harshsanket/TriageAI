import { describe, expect, it } from 'vitest';

import { summarizeUptime } from '../src/services/uptime.js';

describe('uptime summariser (phase 23.2)', () => {
  it('computes per-target percentages, current state and last outage', () => {
    const now = Date.now();
    const summary = summarizeUptime(
      [
        { target: 'database', at: new Date(now - 180_000), ok: true, latency_ms: 1 },
        { target: 'database', at: new Date(now - 120_000), ok: false, latency_ms: 2 },
        { target: 'database', at: new Date(now - 60_000), ok: true, latency_ms: 1 },
        { target: 'ai-service', at: new Date(now - 120_000), ok: true, latency_ms: 4 },
        { target: 'ai-service', at: new Date(now - 60_000), ok: true, latency_ms: 4 },
      ],
      600,
    );
    const database = summary.targets.find((target) => target.target === 'database');
    expect(database).toMatchObject({ uptimePct: 66.67, currentOk: true, probes: 3 });
    expect(database?.lastOutageAt).toBeTruthy();
    expect(summary.targets.find((target) => target.target === 'ai-service')?.uptimePct).toBe(100);
    expect(summary.systemUptimePct).toBe(83.34);
    expect(summary.apiUptimeSec).toBe(600);
  });
});
