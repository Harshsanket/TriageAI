// Phase 22.T13: kill a provider container mid-run and prove core routes stay
// up while only the provider's own routes degrade. Run against a compose
// stack with the `modules` profile after `docker kill triageai-module-echo`.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3000';

export const options = {
  scenarios: {
    core: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'core',
    },
    provider: {
      executor: 'constant-vus',
      vus: 2,
      duration: '2m',
      exec: 'provider',
    },
  },
  thresholds: {
    'http_req_failed{scenario:core}': ['rate<0.01'],
    'http_req_duration{scenario:core}': ['p(95)<500'],
    'http_req_failed{scenario:provider}': ['rate<0.50'],
  },
};

export function core() {
  const response = http.get(`${BASE}/api/v1/system/manifest`);
  check(response, { 'core manifest stays up': (r) => r.status === 200 });
  sleep(0.5);
}

export function provider() {
  // Echo stages over MP1; the route itself is served by the module.
  const response = http.post(`${BASE}/api/v1/echo/run`, JSON.stringify({ text: 'hello' }), {
    headers: { 'content-type': 'application/json' },
  });
  check(response, {
    'provider degrades to 503 or succeeds': (r) => r.status === 200 || r.status === 503,
  });
  sleep(1);
}
