/**
 * Uptime probes (Phase 23.2): one row per target per minute. Probes are
 * deterministic health calls, never model calls; the dashboard reads the rows
 * and the API process exposes its own uptime.
 */
import type { Database, KernelConfig } from '@triageai/kernel';
import type { DashboardUptime, DashboardUptimeTarget } from '@triageai/contracts';

export interface UptimeProbeRow {
  [key: string]: unknown;
  target: string;
  at: Date | string;
  ok: boolean;
  latency_ms: number;
}

export function summarizeUptime(
  rows: UptimeProbeRow[],
  apiUptimeSec: number,
): Omit<DashboardUptime, 'restarts'> {
  const byTarget = new Map<string, UptimeProbeRow[]>();
  for (const row of rows) {
    byTarget.set(row.target, [...(byTarget.get(row.target) ?? []), row]);
  }
  const targets: DashboardUptimeTarget[] = [...byTarget.entries()]
    .map(([target, probes]) => {
      const ordered = probes
        .slice()
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      const ok = ordered.filter((probe) => probe.ok).length;
      const lastOutage = [...ordered].reverse().find((probe) => !probe.ok);
      return {
        target,
        uptimePct: ordered.length === 0 ? 0 : Number(((ok / ordered.length) * 100).toFixed(2)),
        currentOk: ordered.at(-1)?.ok ?? null,
        lastOutageAt: lastOutage ? new Date(lastOutage.at).toISOString() : null,
        probes: ordered.length,
      };
    })
    .sort((a, b) => a.target.localeCompare(b.target));
  const systemUptimePct =
    targets.length === 0
      ? 100
      : Number(
          (targets.reduce((sum, target) => sum + target.uptimePct, 0) / targets.length).toFixed(2),
        );
  return { systemUptimePct, apiUptimeSec, targets };
}

export interface UptimeTarget {
  id: string;
  url?: string;
  kind: 'database' | 'http';
}

export function uptimeTargets(config: KernelConfig, aiServiceUrl: string): UptimeTarget[] {
  const targets: UptimeTarget[] = [{ id: 'database', kind: 'database' }];
  targets.push({
    id: 'ai-service',
    url: `${aiServiceUrl.replace(/\/$/, '')}/healthz`,
    kind: 'http',
  });
  const runtime = String(
    config.capabilities.chatModel?.adapter ?? config.capabilities.generator?.adapter ?? '',
  );
  const baseUrl = String(
    process.env.TRIAGEAI_GENERATOR_BASE_URL ??
      config.capabilities.chatModel?.baseUrl ??
      config.capabilities.generator?.baseUrl ??
      (runtime === 'ollama' ? 'http://localhost:11434' : ''),
  );
  if (runtime && baseUrl) {
    const path = runtime === 'ollama' ? '/api/tags' : '/v1/models';
    targets.push({
      id: `model:${runtime}`,
      url: `${baseUrl.replace(/\/$/, '')}${path}`,
      kind: 'http',
    });
  }
  return targets;
}

async function probe(
  database: Database,
  target: UptimeTarget,
): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    if (target.kind === 'database') {
      await database.query(`SELECT 1`);
    } else if (target.url) {
      await fetch(target.url, { signal: AbortSignal.timeout(3_000) });
    }
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

export async function recordUptimeProbes(
  database: Database,
  targets: UptimeTarget[],
): Promise<void> {
  for (const target of targets) {
    const result = await probe(database, target);
    await database
      .query(`INSERT INTO uptime_probes (target, ok, latency_ms) VALUES ($1, $2, $3)`, [
        target.id,
        result.ok,
        result.latencyMs,
      ])
      .catch(() => undefined);
  }
}

/** Starts the hourly-minute routine; returns a stop function. */
export function startUptimeProbes(
  database: Database,
  getTargets: () => UptimeTarget[],
): () => void {
  let stopped = false;
  const run = () => {
    if (stopped) return;
    void recordUptimeProbes(database, getTargets()).catch(() => undefined);
  };
  run();
  const timer = setInterval(run, 60_000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Records one API boot. The dashboard derives "restarts in the window" from
 * these rows; the current process is part of the count, so the display
 * subtracts it.
 */
export async function recordBoot(database: Database, at = new Date()): Promise<void> {
  await database.query(`INSERT INTO app_boots (at) VALUES ($1)`, [at]);
}

export async function countRestarts(database: Database, since: Date): Promise<number> {
  const rows = await database
    .query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM app_boots WHERE at > $1`, [since])
    .catch(() => []);
  return Math.max(0, Number(rows[0]?.count ?? 0) - 1);
}

/**
 * Downsampling (Phase 23.2): raw minute probes stay for 30 days, then each
 * target/hour keeps one aggregate row. Re-running the pass is idempotent.
 */
export async function downsampleUptimeProbes(
  database: Database,
  olderThanDays = 30,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const existing = await database
    .query<{ min_bucket: Date | string | null }>(
      `SELECT date_trunc('hour', MIN(at)) AS min_bucket
         FROM uptime_probes WHERE downsampled = false AND at < $1`,
      [cutoff],
    )
    .catch(() => []);
  const minBucket = existing[0]?.min_bucket ? new Date(existing[0].min_bucket) : null;
  if (!minBucket) return 0;

  await database.query(
    `DELETE FROM uptime_probes
      WHERE downsampled = true AND at >= $1 AND at < $2`,
    [minBucket, cutoff],
  );
  const inserted = await database.query<{ count: number }>(
    `WITH aggregated AS (
       INSERT INTO uptime_probes (target, at, ok, latency_ms, downsampled)
       SELECT target,
              date_trunc('hour', at) AS bucket,
              bool_and(ok) AS ok,
              GREATEST(0, ROUND(AVG(latency_ms)))::int AS latency_ms,
              true
         FROM uptime_probes
        WHERE downsampled = false AND at < $1
        GROUP BY target, bucket
       RETURNING 1
     )
     SELECT COUNT(*)::int AS count FROM aggregated`,
    [cutoff],
  );
  await database.query(`DELETE FROM uptime_probes WHERE downsampled = false AND at < $1`, [cutoff]);
  return Number(inserted[0]?.count ?? 0);
}

/** Retention (Phase 18.8): probes older than the class retention are deleted. */
export async function pruneUptimeProbes(
  database: Database,
  olderThanDays = 400,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const rows = await database.query<{ count: number }>(
    `WITH deleted AS (DELETE FROM uptime_probes WHERE at < $1 RETURNING 1)
     SELECT COUNT(*)::int AS count FROM deleted`,
    [cutoff],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Maintenance pass: downsample old raw probes, then prune the retention tail. */
export async function runUptimeMaintenance(
  database: Database,
  now = new Date(),
): Promise<{ downsampled: number; pruned: number }> {
  const downsampled = await downsampleUptimeProbes(database, 30, now);
  const pruned = await pruneUptimeProbes(database, 400, now);
  return { downsampled, pruned };
}
