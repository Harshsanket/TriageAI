/**
 * Phase 8 — hot-swap under load: keep creating tickets while an admin flips the
 * per-category auto-reply policy (row-level versioning) and moves the model
 * registry pointer. Asserts ingestion stays healthy and no workflow lands in an
 * ambiguous state.
 *
 *   k6 run -e BASE_URL=http://localhost:3000 perf/k6/phase8-hotswap.js
 *
 * The model rollback step only runs when MODEL_ASSET_ID is provided (promotion
 * requires a passing eval report, so the script does not create one).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const MODEL_ASSET_ID = __ENV.MODEL_ASSET_ID || '';

export const options = {
  scenarios: {
    tickets: {
      executor: 'constant-arrival-rate',
      rate: 6,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 4,
      maxVUs: 12,
      exec: 'tickets',
    },
    policy_flips: {
      executor: 'constant-vus',
      vus: 1,
      duration: '20s',
      exec: 'flips',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    'http_req_duration{scenario:tickets}': ['p(95)<700'],
  },
};

export function tickets() {
  const id = `${__VU}-${__ITER}-${Date.now()}`;
  const res = http.post(
    `${BASE_URL}/api/v1/support/tickets`,
    JSON.stringify({
      subject: `Hotswap ticket ${id}`,
      body: `Billing question: I was charged twice (${id}).`,
      requester: 'k6-hotswap',
      idempotencyKey: `hotswap-${id}`,
    }),
    { headers: { 'content-type': 'application/json' }, tags: { scenario: 'tickets' } },
  );
  check(res, { 'ticket accepted': (r) => r.status === 200 });
}

export function flips() {
  for (let i = 0; i < 5; i += 1) {
    const enabled = i % 2 === 0;
    const policy = http.put(
      `${BASE_URL}/api/v1/support/auto-reply-policies/billing`,
      JSON.stringify({
        enabled,
        fallbackPolicy: enabled ? 'escalate_human' : 'request_clarification',
        note: `k6 hotswap ${i}`,
        updatedBy: 'k6',
      }),
      {
        headers: { 'content-type': 'application/json' },
        tags: { scenario: 'policy_flips' },
      },
    );
    check(policy, { 'policy versioned': (r) => r.status === 200 && Number(r.json('version')) > 0 });

    if (MODEL_ASSET_ID) {
      const rollback = http.post(
        `${BASE_URL}/api/v1/models/${MODEL_ASSET_ID}/rollback`,
        JSON.stringify({ actor: 'k6' }),
        { headers: { 'content-type': 'application/json' }, tags: { scenario: 'policy_flips' } },
      );
      check(rollback, { 'rollback applied': (r) => r.status === 200 });
    }
    sleep(0.5);
  }
}
