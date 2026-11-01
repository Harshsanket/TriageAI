/**
 * Encrypted secret store (Phase 11, ADR-0024): credentials entered in `/config`
 * are stored AES-256-GCM encrypted under a key derived from
 * `TRIAGEAI_SECRET_KEY`, which never touches the database. Without the key the
 * store is unavailable and the wizard asks for env vars instead.
 *
 * Secrets are addressed by the env-var name modules already read (e.g.
 * `GITHUB_TOKEN`), so the host can layer them under `process.env` for
 * `ctx.env` without modules knowing where a value came from.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import type { Database } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// Fixed salt: the key must re-derive identically on every boot; the passphrase
// itself is the secret (≥ 32 chars enforced below).
const KDF_SALT = 'triageai/secret-store/v1';

interface SecretRow {
  [key: string]: unknown;
  name: string;
  ciphertext: string;
  iv: string;
  tag: string;
  updated_by: string;
  updated_at: Date | string;
}

export class SecretStore {
  private readonly key: Buffer | null;

  constructor(
    private readonly database: Database,
    passphrase: string | undefined,
  ) {
    this.key = passphrase && passphrase.length >= 32 ? scryptSync(passphrase, KDF_SALT, 32) : null;
  }

  get available(): boolean {
    return this.key !== null;
  }

  static isValidName(name: string): boolean {
    return SECRET_NAME.test(name);
  }

  async set(name: string, value: string, actor: string): Promise<void> {
    if (!this.key) throw new Error('secret store unavailable: set TRIAGEAI_SECRET_KEY (32+ chars)');
    if (!SecretStore.isValidName(name)) throw new Error(`invalid secret name ${name}`);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    // Bind the ciphertext to its name so rows cannot be swapped between names.
    cipher.setAAD(Buffer.from(name));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    await this.database.query(
      `INSERT INTO secrets (name, ciphertext, iv, tag, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (name) DO UPDATE
         SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [
        name,
        ciphertext.toString('base64'),
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        actor,
      ],
    );
    // Audit the write, never the value.
    await writeAudit(this.database, { actor, action: 'secret.set', subject: name });
  }

  async list(): Promise<
    Array<{ name: string; updatedBy: string; updatedAt: string; lastUsedAt: string | null }>
  > {
    const rows = await this.database
      .query<SecretRow & { last_used_at: Date | string | null }>(
        `SELECT name, updated_by, updated_at, last_used_at FROM secrets ORDER BY name`,
      )
      .catch(() => [] as Array<SecretRow & { last_used_at: Date | string | null }>);
    return rows.map((row) => ({
      name: row.name,
      updatedBy: row.updated_by,
      updatedAt: new Date(row.updated_at).toISOString(),
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    }));
  }

  /** Erase every stored secret (setup "Reset and erase"). */
  async clear(actor: string): Promise<number> {
    const rows = await this.database.query<{ count: number }>(
      `DELETE FROM secrets RETURNING 1 AS count`,
    );
    await writeAudit(this.database, {
      actor,
      action: 'secret.clear',
      subject: String(rows.length),
    });
    return rows.length;
  }

  /**
   * Every secret decrypted, keyed by name. Rows that fail authentication
   * (wrong key, tampering) are skipped and reported, never half-decrypted.
   */
  async loadAll(): Promise<{ values: Record<string, string>; failed: string[] }> {
    if (!this.key) return { values: {}, failed: [] };
    const rows = await this.database
      .query<SecretRow>(`SELECT name, ciphertext, iv, tag FROM secrets`)
      .catch(() => [] as SecretRow[]);
    const values: Record<string, string> = {};
    const failed: string[] = [];
    const used: string[] = [];
    for (const row of rows) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
        decipher.setAAD(Buffer.from(row.name));
        decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
        values[row.name] = Buffer.concat([
          decipher.update(Buffer.from(row.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
        used.push(row.name);
      } catch {
        failed.push(row.name);
      }
    }
    if (used.length > 0) {
      await this.database
        .query(`UPDATE secrets SET last_used_at = now() WHERE name = ANY($1::text[])`, [used])
        .catch(() => undefined);
    }
    return { values, failed };
  }
}
