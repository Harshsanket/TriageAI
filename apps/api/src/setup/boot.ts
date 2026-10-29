/**
 * Boot-time half of the setup wizard (ADR-0024): decide the setup state,
 * layer the saved overlay and secrets into the config, resolve the auth mode,
 * and move `applied` → `complete` once the new config actually boots.
 */
import { randomBytes } from 'node:crypto';

import type { SetupState } from '@triageai/contracts';
import type { Database, Kernel, KernelLogger } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';
import { SecretStore } from './secrets.js';
import { isFreshDatabase, SetupStore, type OverlayVersion } from './store.js';
import { SetupToken } from './token.js';

export const AUTH_MODE_KEY = 'host.authMode';
export const JWT_SECRET_NAME = 'AUTH_JWT_SECRET';

export type AuthMode = 'disabled' | 'required';

/** Mutable view of setup the gate, guard and routes share for this process. */
export interface SetupRuntime {
  enabled: boolean;
  state: SetupState;
  /** Overlay version this process booted with (null = none). */
  bootedOverlayVersion: number | null;
  store: SetupStore;
  secrets: SecretStore;
  token: SetupToken;
  authMode: AuthMode;
  /** Where the auth mode came from, shown on `/config`. */
  authModeSource: 'test' | 'env' | 'setting' | 'default';
}

export interface PreparedSetup {
  runtime: SetupRuntime;
  fresh: boolean;
  overlay: OverlayVersion | null;
  /** process.env over decrypted secrets: env always wins (module-contract §5). */
  env: Record<string, string | undefined>;
  jwtSecret: string;
}

export async function prepareSetup(args: {
  database: Database;
  enabled: boolean;
  secretKey: string | undefined;
  authModeOverride?: AuthMode;
  authModeEnv: AuthMode | undefined;
  jwtSecretEnv: string | undefined;
  devJwtSecret: string;
  nodeEnv: string;
  logger: KernelLogger;
}): Promise<PreparedSetup> {
  const { database } = args;
  const store = new SetupStore(database);
  const secrets = new SecretStore(database, args.secretKey);
  const fresh = await isFreshDatabase(database);
  const state: SetupState = fresh ? (args.enabled ? 'pending' : 'complete') : await store.state();
  const overlay = fresh ? null : await store.latestOverlay();

  const decrypted = await secrets.loadAll();
  if (decrypted.failed.length > 0) {
    args.logger.error(
      { secrets: decrypted.failed },
      'stored secrets could not be decrypted (wrong TRIAGEAI_SECRET_KEY?); they are ignored',
    );
  }
  const env: Record<string, string | undefined> = { ...decrypted.values, ...process.env };

  // Auth mode: test seam → env → wizard setting → default. Env wins like
  // every other override, so AUTH_MODE in compose or .env pins it.
  let authMode: AuthMode;
  let authModeSource: SetupRuntime['authModeSource'];
  const stored = fresh ? null : await readAuthSetting(database);
  if (args.authModeOverride) {
    authMode = args.authModeOverride;
    authModeSource = 'test';
  } else if (args.authModeEnv) {
    authMode = args.authModeEnv;
    authModeSource = 'env';
  } else if (stored) {
    authMode = stored;
    authModeSource = 'setting';
  } else {
    authMode = args.nodeEnv === 'production' ? 'required' : 'disabled';
    authModeSource = 'default';
    if (!fresh && authMode === 'required' && !args.jwtSecretEnv && !env[JWT_SECRET_NAME]) {
      // Installs from before the wizard ran the compose default
      // `AUTH_MODE=disabled`; keep that effective mode rather than refusing
      // to boot, and record it so the choice becomes visible on /config.
      authMode = 'disabled';
      authModeSource = 'setting';
      await writeAuthSetting(database, 'disabled', 'system:legacy-default');
      args.logger.warn(
        'no AUTH_MODE and no JWT secret on an existing install: keeping auth disabled; choose on /config',
      );
    }
  }

  let jwtSecret = args.authModeOverride
    ? args.devJwtSecret
    : (args.jwtSecretEnv ?? env[JWT_SECRET_NAME] ?? null);
  if (!jwtSecret) {
    if (authMode === 'disabled') jwtSecret = args.devJwtSecret;
    else if (state === 'pending') {
      // Nothing but the token-gated wizard is reachable while pending, so a
      // throwaway secret is safe until the wizard stores a real one.
      jwtSecret = randomBytes(32).toString('base64url');
    } else {
      throw new Error(
        'AUTH_JWT_SECRET must be set (env or /config secret store) when auth is required',
      );
    }
  }
  if (jwtSecret.length < 32 && authMode === 'required' && !args.authModeOverride) {
    throw new Error('AUTH_JWT_SECRET must be at least 32 characters when auth is required');
  }

  return {
    runtime: {
      enabled: args.enabled,
      state,
      bootedOverlayVersion: overlay?.version ?? null,
      store,
      secrets,
      token: new SetupToken(),
      authMode,
      authModeSource,
    },
    fresh,
    overlay,
    env,
    jwtSecret,
  };
}

/**
 * A boot with freshly applied answers failed: put the previous overlay back
 * (as a new version), return to `pending` with the error, and let the caller
 * rethrow so the next start boots the last good config.
 */
export async function recoverFailedApply(
  runtime: SetupRuntime,
  error: unknown,
  logger: KernelLogger,
): Promise<void> {
  const message = (error as Error).message ?? String(error);
  try {
    await runtime.store.revertOverlay('system:setup', message.slice(0, 500));
    await runtime.store.setState('pending', 'system:setup', message.slice(0, 2000));
    logger.error({ err: message }, 'applied setup failed to boot; reverted to the previous config');
  } catch (revertErr) {
    logger.error({ err: (revertErr as Error).message }, 'could not revert failed setup');
  }
}

/** After a successful boot: record state transitions and issue the token. */
export async function finishSetupBoot(
  runtime: SetupRuntime,
  fresh: boolean,
  logger: KernelLogger,
  print: (line: string) => void,
): Promise<void> {
  if (fresh) await runtime.store.setState(runtime.state, 'system:first-boot');
  if (runtime.state === 'applied') {
    runtime.state = 'complete';
    await runtime.store.setState('complete', 'system:setup');
    logger.info({ overlayVersion: runtime.bootedOverlayVersion }, 'setup complete');
  }
  if (runtime.state === 'pending' && runtime.enabled) {
    const token = runtime.token.issue();
    print(
      [
        '',
        '  TriageAI first-run setup',
        '  Open the web app and go to /config, then paste this setup token:',
        `      ${token}`,
        '  (valid until setup is applied; a restart issues a new one)',
        '',
      ].join('\n'),
    );
  }
}

/** Import queued wizard documents through the KB module's own routes. */
export async function processPendingImports(
  runtime: SetupRuntime,
  kernel: Kernel,
  logger: KernelLogger,
): Promise<{ imported: number; failed: number }> {
  const routes = kernel.routes();
  const create = routes.find((r) => r.method === 'POST' && r.url === '/api/v1/kb/documents');
  const approve = routes.find(
    (r) => r.method === 'POST' && r.url === '/api/v1/kb/documents/:id/approve',
  );
  const pending = await runtime.store.pendingImports();
  if (!create || pending.length === 0) return { imported: 0, failed: 0 };

  let imported = 0;
  let failed = 0;
  for (const item of pending) {
    try {
      const created = (await create.handler({
        method: 'POST',
        url: create.url,
        params: {},
        query: {},
        body: { title: item.title, body: item.body, source: item.source },
        actor: 'system:setup',
      })) as { document: { id: string } };
      if (item.autoApprove && approve) {
        await approve.handler({
          method: 'POST',
          url: approve.url,
          params: { id: created.document.id },
          query: {},
          body: {},
          actor: 'system:setup',
        });
      }
      await runtime.store.markImport(item.id, 'imported', created.document.id);
      imported += 1;
    } catch (err) {
      await runtime.store.markImport(item.id, 'failed', (err as Error).message.slice(0, 500));
      failed += 1;
    }
  }
  logger.info({ imported, failed }, 'setup knowledge imports processed');
  return { imported, failed };
}

async function readAuthSetting(database: Database): Promise<AuthMode | null> {
  const rows = (await database
    .query(`SELECT value FROM settings WHERE key = $1`, [AUTH_MODE_KEY])
    .catch(() => [])) as Array<{ value: AuthMode }>;
  const value = rows[0]?.value;
  return value === 'disabled' || value === 'required' ? value : null;
}

export async function writeAuthSetting(
  database: Database,
  mode: AuthMode,
  actor: string,
): Promise<void> {
  await database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [AUTH_MODE_KEY, mode, actor],
  );
  await writeAudit(database, { actor, action: 'setup.auth_mode', subject: mode });
}
