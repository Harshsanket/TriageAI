import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { Capabilities, ClassificationResult } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { SecretStore } from '../src/setup/secrets.js';
import type { SetupRuntime } from '../src/setup/boot.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const DB_NAME = 'triageai_setup_test';
const SETUP_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);

type App = FastifyInstance & { setupRuntime?: SetupRuntime };

const fakeCapabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), modelVersion: 'fake' }),
  },
  classifier: {
    classify: async (): Promise<ClassificationResult> => ({
      category: 'billing',
      confidence: 0.9,
      margin: 0.4,
      method: 'zero-shot',
      modelVersion: 'fake',
      scores: [{ category: 'billing', score: 0.9 }],
    }),
  },
};

const ticketSolverAnswers = {
  interfaces: ['ticket-solver'],
  llm: { runtime: 'none' },
  ticketSolver: { autoReply: false },
  knowledge: {
    autoApprove: true,
    documents: [{ title: 'Refunds', body: 'Refunds take five days.' }],
  },
  access: {
    authMode: 'disabled',
    admin: { email: 'owner@setup.test', password: 'owner-password-123', name: 'Owner' },
  },
};

async function resetDatabase(): Promise<void> {
  const admin = new PostgresDatabase(BASE_URL);
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.close();
  }
}

const boot = (extra: Record<string, unknown> = {}) =>
  buildApp({
    quiet: true,
    databaseUrl: SETUP_URL,
    setup: true,
    capabilities: fakeCapabilities,
    configPath: 'triage.config.json',
    ...extra,
  }) as Promise<App>;

/**
 * Phase 11 first-run wizard (ADR-0024) against a brand-new database: gate,
 * setup token, planning, apply, the restart that completes setup, recovery
 * from an applied config that cannot boot, and the secret store.
 */
describeIfDb('first-run setup (phase 11)', () => {
  beforeAll(resetDatabase, 60_000);
  afterAll(async () => {
    const admin = new PostgresDatabase(BASE_URL);
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => undefined);
    await admin.close();
  });

  it('gates a fresh install behind the setup token and applies the answers', async () => {
    const app = await boot();
    try {
      const status = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
      expect(status.json()).toMatchObject({ state: 'pending', tokenRequired: true });

      const blocked = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ title: 'setup.REQUIRED' });

      const noToken = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/plan',
        payload: ticketSolverAnswers,
      });
      expect(noToken.statusCode).toBe(401);

      const token = app.setupRuntime?.token.peek();
      expect(token).toBeTruthy();
      const auth = { authorization: `Setup ${token}` };

      const badPlan = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/plan',
        headers: auth,
        payload: { ...ticketSolverAnswers, interfaces: ['chatbot'] },
      });
      expect(badPlan.json().problems.join(' ')).toMatch(/need an LLM runtime/);

      const plan = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/plan',
        headers: auth,
        payload: ticketSolverAnswers,
      });
      expect(plan.statusCode).toBe(200);
      expect(plan.json()).toMatchObject({
        enabledModules: ['ai-pipeline', 'support'],
        problems: [],
      });

      // Drafts never keep credentials.
      await app.inject({
        method: 'PUT',
        url: '/api/v1/setup/draft',
        headers: auth,
        payload: { access: { admin: { password: 'owner-password-123' } } },
      });
      const draft = await app.inject({ method: 'GET', url: '/api/v1/setup/draft', headers: auth });
      expect(JSON.stringify(draft.json())).not.toContain('owner-password-123');

      const applied = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/apply',
        headers: auth,
        payload: ticketSolverAnswers,
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toMatchObject({
        applied: true,
        adminCreated: true,
        importsQueued: 1,
        restartRequired: true,
      });

      // The token dies with the apply; everything else waits for the restart.
      expect(app.setupRuntime?.token.active).toBe(false);
      const stillGated = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      expect(stillGated.json()).toMatchObject({ title: 'setup.REQUIRED' });
      const status2 = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
      expect(status2.json()).toMatchObject({ state: 'applied', restartRequired: true });
    } finally {
      await app.close();
    }
  }, 60_000);

  it('completes setup when the applied config boots', async () => {
    const app = await boot();
    try {
      const status = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
      expect(status.json()).toMatchObject({
        state: 'complete',
        restartRequired: false,
        overlayVersion: 1,
      });
      const manifest = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      expect(manifest.statusCode).toBe(200);
      const ids = (manifest.json() as { modules: Array<{ id: string }> }).modules.map((m) => m.id);
      expect(ids).toContain('support');
      expect(ids).not.toContain('echo');

      const effective = await app.inject({
        method: 'GET',
        url: '/api/v1/setup/config/effective',
      });
      expect(effective.json()).toMatchObject({ bootedOverlayVersion: 1, authMode: 'disabled' });

      const audit = await app.kernel!.database.query(
        `SELECT action FROM audit_events WHERE action LIKE 'setup.%' OR action LIKE 'config.%'`,
      );
      const actions = audit.map((row) => (row as { action: string }).action);
      expect(actions).toEqual(
        expect.arrayContaining(['setup.state_changed', 'config.overlay_written']),
      );
    } finally {
      await app.close();
    }
  }, 60_000);

  it('reverts an applied config that fails to boot and reopens setup', async () => {
    const database = new PostgresDatabase(SETUP_URL);
    try {
      // `kb` needs vectorStore/retriever adapters the fake bag does not have.
      await database.query(
        `INSERT INTO config_overlays (overlay, note, created_by) VALUES ($1, 'broken', 'test')`,
        [{ modules: { kb: { enabled: true } } }],
      );
      await database.query(`UPDATE settings SET value = '"applied"' WHERE key = 'setup.state'`);
    } finally {
      await database.close();
    }

    await expect(boot()).rejects.toThrow(/capability/);

    const app = await boot();
    try {
      const status = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
      expect(status.json()).toMatchObject({ state: 'pending', tokenRequired: true });
      expect(status.json().lastError).toMatch(/capability/);
      const manifest = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      expect(manifest.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  }, 60_000);

  it('encrypts secrets, binds them to their name, and refuses a wrong key', async () => {
    const database = new PostgresDatabase(SETUP_URL);
    try {
      const store = new SecretStore(database, 'k'.repeat(40));
      await store.set('GITHUB_TOKEN', 'ghp_example_value', 'test');
      const raw = await database.query(
        `SELECT ciphertext FROM secrets WHERE name = 'GITHUB_TOKEN'`,
      );
      expect(JSON.stringify(raw)).not.toContain('ghp_example_value');
      expect((await store.loadAll()).values.GITHUB_TOKEN).toBe('ghp_example_value');

      const wrongKey = new SecretStore(database, 'x'.repeat(40));
      expect(await wrongKey.loadAll()).toMatchObject({ values: {}, failed: ['GITHUB_TOKEN'] });

      // Moving a ciphertext under another name fails authentication.
      await database.query(
        `INSERT INTO secrets (name, ciphertext, iv, tag, updated_by)
         SELECT 'SLACK_WEBHOOK_URL', ciphertext, iv, tag, 'test' FROM secrets WHERE name = 'GITHUB_TOKEN'`,
      );
      expect((await store.loadAll()).failed).toContain('SLACK_WEBHOOK_URL');
      expect(new SecretStore(database, 'short').available).toBe(false);
    } finally {
      await database.close();
    }
  });
});
