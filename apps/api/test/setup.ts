import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Test environment defaults. Loaded before test modules import src/platform/config,
 * which validates env at import time. Integration tests that need a real DB
 * override these with actual values (docker compose up).
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://triageai:triageai@localhost:5432/triageai';
process.env.AI_SERVICE_URL ??= 'http://localhost:8000';
process.env.LOG_LEVEL ??= 'fatal';
process.env.RATE_LIMIT_DISABLED ??= '1';
// Integration suites boot against a service-container database; the first-run
// gate would otherwise 409 every route on a fresh CI database. Setup tests opt
// back in explicitly with `buildApp({ setup: true })`.
process.env.TRIAGEAI_SETUP ??= 'off';
// Keep generated secret-store keys out of the checkout during tests.
if (!process.env.TRIAGEAI_SECRETS_DIR) {
  process.env.TRIAGEAI_SECRETS_DIR = mkdtempSync(join(tmpdir(), 'triageai-secrets-'));
}
