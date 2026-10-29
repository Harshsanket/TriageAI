/**
 * Persistence for the first-run wizard (ADR-0024): setup state and draft in
 * `settings`, versioned config overlays, and knowledge imports queued until the
 * KB module is running. Every write is audited.
 */
import { ulid } from 'ulid';

import type { SetupState } from '@triageai/contracts';
import type { Database } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';

const STATE_KEY = 'setup.state';
const DRAFT_KEY = 'setup.draft';
const ERROR_KEY = 'setup.lastError';

export interface OverlayVersion {
  version: number;
  overlay: Record<string, unknown>;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface PendingImport {
  id: string;
  title: string;
  body: string;
  source: string;
  autoApprove: boolean;
}

/**
 * Was this database empty before this boot? Checked before kernel migrations
 * run: a database without `kernel_migrations` has never booted TriageAI, so it
 * gets the first-run wizard. Existing installs (and test databases) are
 * treated as already set up.
 */
export async function isFreshDatabase(database: Database): Promise<boolean> {
  const rows = (await database.query(
    `SELECT to_regclass('public.kernel_migrations') IS NULL AS fresh`,
  )) as Array<{ fresh: boolean }>;
  return rows[0]?.fresh ?? false;
}

export class SetupStore {
  constructor(private readonly database: Database) {}

  private async getSetting<T>(key: string): Promise<T | null> {
    const rows = (await this.database
      .query(`SELECT value FROM settings WHERE key = $1`, [key])
      .catch(() => [])) as Array<{ value: T }>;
    return rows[0]?.value ?? null;
  }

  private async putSetting(key: string, value: unknown, actor: string): Promise<void> {
    await this.database.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      // postgres-js JSON-encodes every param bound to a JSONB column (objects
      // and strings alike), so pass the value itself — never JSON.stringify.
      [key, value, actor],
    );
  }

  /** Missing state means an install that predates the wizard: treat as complete. */
  async state(): Promise<SetupState> {
    return (await this.getSetting<SetupState>(STATE_KEY)) ?? 'complete';
  }

  async setState(state: SetupState, actor: string, error: string | null = null): Promise<void> {
    await this.putSetting(STATE_KEY, state, actor);
    // `settings.value` is NOT NULL: a cleared error removes the row.
    if (error === null)
      await this.database.query(`DELETE FROM settings WHERE key = $1`, [ERROR_KEY]);
    else await this.putSetting(ERROR_KEY, error, actor);
    await writeAudit(this.database, {
      actor,
      action: 'setup.state_changed',
      subject: state,
      payload: error ? { error } : {},
    });
  }

  async lastError(): Promise<string | null> {
    return this.getSetting<string>(ERROR_KEY);
  }

  async draft(): Promise<unknown> {
    return this.getSetting(DRAFT_KEY);
  }

  async saveDraft(draft: unknown, actor: string): Promise<void> {
    await this.putSetting(DRAFT_KEY, draft, actor);
  }

  async latestOverlay(): Promise<OverlayVersion | null> {
    const rows = (await this.database
      .query(
        `SELECT version, overlay, note, created_by, created_at FROM config_overlays
         ORDER BY version DESC LIMIT 1`,
      )
      .catch(() => [])) as Array<Record<string, unknown>>;
    return rows[0] ? toOverlay(rows[0]) : null;
  }

  async overlayHistory(limit = 20): Promise<OverlayVersion[]> {
    const rows = (await this.database.query(
      `SELECT version, overlay, note, created_by, created_at FROM config_overlays
       ORDER BY version DESC LIMIT $1`,
      [limit],
    )) as Array<Record<string, unknown>>;
    return rows.map(toOverlay);
  }

  async writeOverlay(
    overlay: Record<string, unknown>,
    actor: string,
    note: string,
  ): Promise<number> {
    const rows = (await this.database.query(
      `INSERT INTO config_overlays (overlay, note, created_by) VALUES ($1, $2, $3)
       RETURNING version`,
      [overlay, note, actor],
    )) as Array<{ version: number }>;
    const version = rows[0]?.version as number;
    await writeAudit(this.database, {
      actor,
      action: 'config.overlay_written',
      subject: String(version),
      payload: { note, overlay },
    });
    return version;
  }

  /**
   * Roll back to the previous overlay by writing it again as a new version, so
   * history stays append-only.
   */
  async revertOverlay(actor: string, reason: string): Promise<number | null> {
    const rows = (await this.database.query(
      `SELECT overlay FROM config_overlays ORDER BY version DESC OFFSET 1 LIMIT 1`,
    )) as Array<{ overlay: Record<string, unknown> }>;
    return this.writeOverlay(rows[0]?.overlay ?? {}, actor, `revert: ${reason}`);
  }

  async queueImports(
    documents: Array<{ title: string; body: string; source: string }>,
    autoApprove: boolean,
  ): Promise<number> {
    for (const doc of documents) {
      await this.database.query(
        `INSERT INTO setup_imports (id, title, body, source, auto_approve) VALUES ($1, $2, $3, $4, $5)`,
        [ulid(), doc.title, doc.body, doc.source, autoApprove],
      );
    }
    return documents.length;
  }

  async pendingImports(): Promise<PendingImport[]> {
    const rows = (await this.database
      .query(
        `SELECT id, title, body, source, auto_approve FROM setup_imports
         WHERE status = 'pending' ORDER BY created_at`,
      )
      .catch(() => [])) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      body: row.body as string,
      source: row.source as string,
      autoApprove: row.auto_approve as boolean,
    }));
  }

  async markImport(id: string, status: 'imported' | 'failed', detail: string | null) {
    await this.database.query(
      `UPDATE setup_imports
          SET status = $2, document_id = CASE WHEN $2 = 'imported' THEN $3 ELSE document_id END,
              error = CASE WHEN $2 = 'failed' THEN $3 ELSE NULL END, processed_at = now()
        WHERE id = $1`,
      [id, status, detail],
    );
  }
}

function toOverlay(row: Record<string, unknown>): OverlayVersion {
  return {
    version: row.version as number,
    overlay: (row.overlay ?? {}) as Record<string, unknown>,
    note: (row.note as string | null) ?? null,
    createdBy: row.created_by as string,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}
