/**
 * Phase 8 — ingestion burst: create support tickets (which fan out to
 * classification, routing, auto-reply and integration workflows).
 *
 *   k6 run -e BASE_URL=http://localhost:3000 -e RATE=10 perf/k6/phase8-ingest.js
 *
 * Ingest latency and processing drain are measured separately (drain.js).
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const RATE = Number(__ENV.RATE || 10);

export const options = {
  scenarios: {
    tickets: {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      preAllocatedVUs: 4,
      maxVUs: 20,
      stages: [
        { target: Math.max(2, Math.floor(RATE / 2)), duration: '5s' },
        { target: RATE, duration: '15s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:tickets}': ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export default function ingest() {
  const id = `${__VU}-${__ITER}-${Date.now()}`;
  const payload = JSON.stringify({
    subject: `Phase 8 burst ${id}`,
    body: `Load test ticket ${id}: app failed with an error while exporting data.`,
    requester: `k6-${__VU}`,
    idempotencyKey: `phase8-${id}`,
  });
  const res = http.post(`${BASE_URL}/api/v1/support/tickets`, payload, {
    headers: { 'content-type': 'application/json' },
    tags: { scenario: 'tickets' },
  });
  check(res, {
    'ticket accepted': (r) => r.status === 200,
    'run id returned': (r) => typeof r.json('runId') === 'string',
  });
}
