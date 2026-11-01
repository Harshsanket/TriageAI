import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import type { Capabilities, ClassificationResult } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { SecretStore } from '../src/setup/secrets.js';
import { prepareSetup, type SetupRuntime } from '../src/setup/boot.js';

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

  it('never downgrades required auth when no JWT secret exists (R4)', async () => {
    const database = new PostgresDatabase(SETUP_URL);
    try {
      await database.query(
        `INSERT INTO settings (key, value, updated_by, updated_at)
         VALUES ('host.authMode', '"required"', 'test', now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      const prepared = await prepareSetup({
        database,
        enabled: true,
        secretKey: undefined,
        authModeEnv: undefined,
        jwtSecretEnv: undefined,
        devJwtSecret: 'development-only-insecure-secret-change-me',
        nodeEnv: 'production',
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      // Phase 23.7: the generated key file makes the store available, so R4
      // generates and stores a JWT secret instead of disabling auth.
      expect(prepared.runtime.authMode).toBe('required');
      expect(prepared.jwtSecret.length).toBeGreaterThanOrEqual(32);
    } finally {
      await database.query(`DELETE FROM settings WHERE key = 'host.authMode'`);
      await database.close();
    }
  });

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

  it('writes a new overlay version and audit row when setup changes after completion', async () => {
    const app = await boot();
    try {
      const applied = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/apply',
        payload: { ...ticketSolverAnswers, ticketSolver: { autoReply: true } },
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.json()).toMatchObject({ applied: true, overlayVersion: 2 });

      const versions = await app.kernel!.database.query(
        `SELECT version FROM config_overlays ORDER BY version`,
      );
      expect(versions.map((row) => (row as { version: number }).version)).toEqual([1, 2]);
      const audit = await app.kernel!.database.query(
        `SELECT subject FROM audit_events WHERE action = 'config.overlay_written' ORDER BY id`,
      );
      expect(audit.map((row) => (row as { subject: string }).subject)).toContain('2');
    } finally {
      await app.close();
    }

    // The next boot uses the newest overlay and stays complete.
    const rebooted = await boot();
    try {
      const status = await rebooted.inject({ method: 'GET', url: '/api/v1/setup/status' });
      expect(status.json()).toMatchObject({ state: 'complete', overlayVersion: 2 });
    } finally {
      await rebooted.close();
    }
  }, 60_000);

  it('offers agent defaults and adds/removes interfaces with a soft reload', async () => {
    const app = await boot();
    try {
      const defaults = await app.inject({
        method: 'GET',
        url: '/api/v1/setup/agent-defaults?interfaces=chatbot,ticket-solver',
      });
      expect(defaults.statusCode).toBe(200);
      const agents = (defaults.json() as { agents: Array<{ displayName: string; color: string }> })
        .agents;
      expect(agents.map((agent) => agent.displayName)).toEqual(['Voyager', 'Pioneer']);
      expect(agents[0]?.color).not.toBe(agents[1]?.color);

      const added = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/add',
        payload: { interfaces: ['notifications-github'] },
      });
      expect(added.statusCode).toBe(200);
      expect(added.json()).toMatchObject({ reloaded: true });
      const withGithub = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      expect(
        (withGithub.json() as { modules: Array<{ id: string }> }).modules.map(
          (module) => module.id,
        ),
      ).toContain('integrations-github');

      const removed = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/remove',
        payload: { interfaces: ['notifications-github'] },
      });
      expect(removed.statusCode).toBe(200);
      const withoutGithub = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      expect(
        (withoutGithub.json() as { modules: Array<{ id: string }> }).modules.map(
          (module) => module.id,
        ),
      ).not.toContain('integrations-github');
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
      await database.query(`DELETE FROM secrets`);
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

  it('erases setup, uninstalls modules and returns to the token gate', async () => {
    await resetDatabase();
    const first = await boot();
    try {
      const token = first.setupRuntime?.token.peek();
      const applied = await first.inject({
        method: 'POST',
        url: '/api/v1/setup/apply',
        headers: { authorization: `Setup ${token}` },
        payload: { ...ticketSolverAnswers, knowledge: { autoApprove: false, documents: [] } },
      });
      expect(applied.statusCode).toBe(200);
    } finally {
      await first.close();
    }
    const app = await boot();
    try {
      const erased = await app.inject({
        method: 'POST',
        url: '/api/v1/setup/erase',
        payload: { confirm: 'TriageAI' },
      });
      expect(erased.statusCode).toBe(200);
      expect(erased.json()).toMatchObject({ erased: true, tokenRequired: true });
      expect((erased.json() as { uninstalled: string[] }).uninstalled).toContain('support');
      const status = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
      expect(status.json()).toMatchObject({ state: 'pending', tokenRequired: true });
      const blocked = await app.inject({ method: 'GET', url: '/api/v1/system/manifest' });
      expect(blocked.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  }, 60_000);
});
