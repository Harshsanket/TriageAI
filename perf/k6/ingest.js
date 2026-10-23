/**
 * k6 v1 — ingestion load: POST workflow runs through the api host.
 *
 *   k6 run -e BASE_URL=http://localhost:3000 perf/k6/ingest.js
 *   docker run --rm -i --network host grafana/k6 run - < perf/k6/ingest.js
 *
 * Processing throughput is measured separately in drain.js (ingestion ≠ processing).
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    ingest: {
      executor: 'ramping-arrival-rate',
      startRate: 2,
      timeUnit: '1s',
      preAllocatedVUs: 2,
      maxVUs: 10,
      stages: [
        { target: 5, duration: '5s' },
        { target: 10, duration: '5s' },
      ],
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:ingest}': ['p(95)<500'],
    checks: ['rate>0.99'],
  },
};

export default function ingest() {
  const payload = JSON.stringify({ text: `k6 ingest ${__ITER}` });
  const res = http.post(`${BASE_URL}/api/v1/echo/run`, payload, {
    headers: { 'content-type': 'application/json' },
    tags: { scenario: 'ingest' },
  });
  check(res, {
    'status is 200': (r) => r.status === 200,
    'run id returned': (r) => typeof r.json('runId') === 'string',
  });
}
