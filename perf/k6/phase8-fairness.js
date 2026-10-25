/**
 * Phase 8 — queue fairness: run lightweight echo workflows and heavier support
 * tickets at the same time and assert both scenarios keep their own p95 budget
 * (no workload starves the other in the shared pg-queue).
 *
 *   k6 run -e BASE_URL=http://localhost:3000 perf/k6/phase8-fairness.js
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    echo: {
      executor: 'constant-arrival-rate',
      rate: 8,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 4,
      maxVUs: 10,
      exec: 'echo',
    },
    tickets: {
      executor: 'constant-arrival-rate',
      rate: 4,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 4,
      maxVUs: 10,
      exec: 'tickets',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:echo}': ['p(95)<300'],
    'http_req_duration{scenario:tickets}': ['p(95)<600'],
  },
};

export function echo() {
  const res = http.post(
    `${BASE_URL}/api/v1/echo/run`,
    JSON.stringify({ text: `fairness echo ${__ITER}` }),
    { headers: { 'content-type': 'application/json' }, tags: { scenario: 'echo' } },
  );
  check(res, { 'echo accepted': (r) => r.status === 200 });
}

export function tickets() {
  const id = `${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${BASE_URL}/api/v1/support/tickets`,
    JSON.stringify({
      subject: `Fairness ticket ${id}`,
      body: `Please help, the export failed with an error (${id}).`,
      requester: 'k6-fairness',
      idempotencyKey: `fairness-${id}`,
    }),
    { headers: { 'content-type': 'application/json' }, tags: { scenario: 'tickets' } },
  );
  check(res, { 'ticket accepted': (r) => r.status === 200 });
}
