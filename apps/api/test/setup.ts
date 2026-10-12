/**
 * Test environment defaults. Loaded before test modules import src/platform/config,
 * which validates env at import time. Integration tests that need a real DB
 * override these with actual values (docker compose up).
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgres://triageai:triageai@localhost:5432/triageai';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.AI_SERVICE_URL ??= 'http://localhost:8000';
process.env.LOG_LEVEL ??= 'fatal';
