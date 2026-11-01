/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(rootPackage.version) },
  server: {
    port: 5173,
    // R24: the dev server needs inline scripts for HMR; keep the production
    // CSP (nginx/API) strict and use a dev-only superset here.
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: http://localhost:3000; frame-ancestors 'none'; base-uri 'self'",
    },
    proxy: {
      // Phase 1 will point customer/agent traffic at the API.
      '/api': 'http://localhost:3000',
      '/plugins': 'http://localhost:3000',
      '/v1': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
