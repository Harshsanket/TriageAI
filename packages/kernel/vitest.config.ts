import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // DB-backed suites (pg-queue contract, boot integration) skip when no
    // DATABASE_URL is reachable; CI provides a postgres service.
    hookTimeout: 15000,
    testTimeout: 20000,
  },
});
