/** Core skill read/capture API (ADR-0060); modules never read `user_skills` directly. */
import { ulid } from 'ulid';

import type { Database, SkillCapture, SkillInstruction, SkillReadApi } from '../types.js';
import { capturePreference, skillMarkdown, slugifySkillName } from './index.js';

interface SkillRow {
  [key: string]: unknown;
  id: string;
  content: string;
  version: number;
}

export function createSkillReadApi(database: Database): SkillReadApi {
  return {
    async enabled(ownerId: string | null): Promise<SkillInstruction[]> {
      const rows = await database.query<{ name: string; version: number; content: string }>(
        `SELECT name, version, content FROM user_skills
          WHERE enabled AND NOT suggestion AND NOT ignored
            AND (owner_id = $1 OR owner_id IS NULL)
          ORDER BY name LIMIT 50`,
        [ownerId],
      );
      return rows.map((row) => ({
        name: row.name,
        version: Number(row.version),
        content: row.content,
      }));
    },

    async capture(
      ownerId: string | null,
      text: string,
      _actor?: string | null,
    ): Promise<SkillCapture> {
      const captured = capturePreference(text);
      if (!captured) return { kind: 'none', added: false, name: null, notice: null };
      const name = slugifySkillName(captured.instruction.split(/\s+/).slice(0, 6).join(' '));
      const description = captured.instruction.slice(0, 300);
      const content = skillMarkdown(
        name,
        description,
        `When responding:\n- ${captured.instruction}`,
      );
      const explicit = captured.kind === 'explicit';
      const existing = await database.query<SkillRow>(
        `SELECT id, content, version FROM user_skills
          WHERE COALESCE(owner_id, '') = $1 AND name = $2 LIMIT 1`,
        [ownerId ?? '', name],
      );
      if (existing[0]) {
        if (existing[0].content === content) {
          return { kind: captured.kind, added: false, name, notice: null };
        }
        await database.query(
          `UPDATE user_skills
              SET content = $2, description = $3, enabled = $4, suggestion = $5,
                  version = version + 1, updated_at = now()
            WHERE id = $1`,
          [existing[0].id, content, description, explicit, !explicit],
        );
        return {
          kind: captured.kind,
          added: true,
          name,
          notice: explicit ? `Updated skill: ${name} · Manage in Skills` : null,
        };
      }
      await database.query(
        `INSERT INTO user_skills
           (id, owner_id, scope, name, description, content, enabled, provenance, suggestion)
         VALUES ($1,$2,'user',$3,$4,$5,$6,'chat',$7)`,
        [ulid(), ownerId, name, description, content, explicit, !explicit],
      );
      return {
        kind: captured.kind,
        added: true,
        name,
        notice: explicit ? `Added skill: ${name} · Manage in Skills` : null,
      };
    },
  };
}
