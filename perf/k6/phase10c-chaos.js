/**
 * Phase 10C chaos probe: submit work while the ai-service is stopped and
 * assert the API stays within the error budget (no bare 500s) and recovers.
 *
 *   k6 run -e BASE_URL=http://localhost:3000 perf/k6/phase10c-chaos.js
 *
 * Pair it with `docker compose stop ai-service` / `start` in another shell.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const bare500 = new Counter('bare_500_total');
const typedError = new Counter('typed_error_total');
const healthy = new Counter('healthy_total');
const latency = new Trend('chaos_latency_ms', true);
const availability = new Rate('availability');

export const options = {
  scenarios: {
    chaos: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 5),
      duration: __ENV.DURATION || '60s',
    },
  },
  thresholds: {
    // During an outage the API may fail, but only with the error envelope.
    bare_500_total: ['count==0'],
    availability: ['rate>0.9'],
    chaos_latency_ms: ['p(95)<2500'],
  },
};

export default function chaos() {
  const started = Date.now();
  const res = http.post(
    `${BASE_URL}/api/v1/support/tickets`,
    JSON.stringify({ subject: 'Chaos probe', body: `outage check ${Date.now()}` }),
    { headers: { 'content-type': 'application/json' }, tags: { name: 'create-ticket' } },
  );
  latency.add(Date.now() - started);

  if (res.status === 500) {
    let envelope = false;
    try {
      const body = res.json();
      envelope = Boolean(body && body.code && body.category && body.correlationId);
    } catch {
      envelope = false;
    }
    if (envelope) typedError.add(1);
    else bare500.add(1);
  }

  const ok = check(res, {
    'health or typed envelope': (r) =>
      r.status === 200 || (r.json() && r.json().code && !String(r.body).includes(' at ')),
  });
  availability.add(ok);
  sleep(0.25);
}

export function handleSummary(data) {
  return {
    'perf/k6/phase10c-chaos-summary.json': JSON.stringify(data, null, 2),
    stdout: `chaos done: bare_500=${data.metrics.bare_500_total?.values.count ?? 0}\n`,
  };
}
