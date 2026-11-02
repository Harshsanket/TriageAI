import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  summarizeUptime,
  countRestarts,
  downsampleUptimeProbes,
  recordBoot,
} from '../src/services/uptime.js';
import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

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

describeIfDb('uptime maintenance (phase 23.2)', () => {
  let app: FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };
  const target = `test:uptime:${Date.now()}`;

  beforeAll(async () => {
    app = (await buildApp({ quiet: true, setup: false, authMode: 'disabled' })) as typeof app;
  });

  afterAll(async () => {
    await app.kernel?.database.query(`DELETE FROM uptime_probes WHERE target = $1`, [target]);
    await app.close();
  });

  it('downsamples raw probes older than 30 days into hourly rows', async () => {
    const db = app.kernel!.database;
    await db.query(`DELETE FROM uptime_probes WHERE target = $1`, [target]);
    await db.query(
      `INSERT INTO uptime_probes (target, at, ok, latency_ms)
       VALUES ($1, now() - interval '40 days', true, 10),
              ($1, now() - interval '40 days', false, 30),
              ($1, now() - interval '2 days', true, 20)`,
      [target],
    );
    const inserted = await downsampleUptimeProbes(db, 30);
    expect(inserted).toBeGreaterThan(0);
    const rows = await db.query<{
      ok: boolean;
      latency_ms: number;
      downsampled: boolean;
      at: string;
    }>(`SELECT ok, latency_ms, downsampled, at FROM uptime_probes WHERE target = $1 ORDER BY at`, [
      target,
    ]);
    expect(rows).toHaveLength(2);
    const old = rows.find((row) => new Date(row.at).getTime() < Date.now() - 30 * 86_400_000);
    expect(old).toMatchObject({ ok: false, downsampled: true });
    expect(Number(old?.latency_ms)).toBe(20);
    expect(rows.some((row) => !row.downsampled)).toBe(true);
  });

  it('counts restarts as boot rows in the window minus the current process', async () => {
    const db = app.kernel!.database;
    await db.query(`DELETE FROM app_boots WHERE at < '2021-01-01'`);
    const [one] = await db.query<{ at: string }>(
      `INSERT INTO app_boots (at) VALUES ('2020-01-01T00:00:00Z') RETURNING at`,
    );
    expect(one).toBeTruthy();
    await recordBoot(db, new Date('2020-01-01T01:00:00Z'));
    await recordBoot(db, new Date('2020-01-01T02:00:00Z'));
    expect(await countRestarts(db, new Date('2019-12-31T00:00:00Z'))).toBe(2);
  });
});
