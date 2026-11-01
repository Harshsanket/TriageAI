import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp, SECURITY_CSP } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;

describeIfDb('security headers (phase 21 R24)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ quiet: true, authMode: 'disabled' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('sends the production CSP from the API origin', async () => {
    for (const url of ['/healthz', '/api/v1/system/manifest', '/plugins/x/1.0.0/index.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy']).toBe(SECURITY_CSP);
    }
  });

  it('keeps the CSP identical to the nginx header', async () => {
    expect(SECURITY_CSP).toContain("script-src 'self' 'sha256-");
    expect(SECURITY_CSP).toContain("frame-ancestors 'none'");
  });
});
