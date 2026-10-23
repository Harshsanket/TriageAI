/**
 * k6 v1 — processing/drain probe: polls kernel metrics until the workflow queue
 * is empty, emitting `drain_time_ms`.
 *
 *   k6 run -e BASE_URL=http://localhost:3000 perf/k6/drain.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const drainTime = new Trend('drain_time_ms', true);
const MAX_WAIT_MS = Number(__ENV.MAX_WAIT_MS || 60000);
const POLL_MS = 250;

export const options = {
  scenarios: {
    drain: { executor: 'shared-iterations', vus: 1, iterations: 1 },
  },
  thresholds: {
    drain_time_ms: [`p(95)<${MAX_WAIT_MS}`],
  },
};

function queueBacklog() {
  const res = http.get(`${BASE_URL}/metrics`);
  check(res, { 'metrics scraped': (r) => r.status === 200 });
  const match = [
    ...res.body.matchAll(
      /triageai_queue_jobs\{[^}]*queue="workflow\.run"[^}]*status="(pending|processing)"[^}]*\}\s+(\d+)/g,
    ),
  ];
  return match.reduce((sum, m) => sum + Number(m[2]), 0);
}

export default function drain() {
  const started = Date.now();
  for (;;) {
    const backlog = queueBacklog();
    if (backlog === 0) break;
    if (Date.now() - started > MAX_WAIT_MS) break;
    sleep(POLL_MS / 1000);
  }
  drainTime.add(Date.now() - started);
}
