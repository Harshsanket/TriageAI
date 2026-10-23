import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    environment: 'node',
    // Kernel instances share one Postgres queue; parallel test files with
    // different module sets would steal each other's workflow.run jobs.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
