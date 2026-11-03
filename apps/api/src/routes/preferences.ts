/**
 * Per-user appearance preferences (Phase 20.7). One row per user; admin
 * defaults come from the latest config overlay. Agent renames/colours update
 * the same `agent_definitions` fields the dashboard reads.
 */
import type { FastifyInstance } from 'fastify';

import {
  AppearancePreferencesSchema,
  PreferencesResponseSchema,
  PreferencesUpdateSchema,
  type AppearancePreferences,
  type PreferencesResponse,
} from '@triageai/contracts';
import type { Kernel } from '@triageai/kernel';
import { AppError } from '@triageai/kernel';

import { writeAudit } from '../services/audit.js';

async function readDefaults(kernel: Kernel): Promise<AppearancePreferences | null> {
  const rows = await kernel.database
    .query<{ overlay: { appearance?: { defaults?: unknown } } }>(
      `SELECT overlay FROM config_overlays ORDER BY version DESC LIMIT 1`,
    )
    .catch(() => []);
  const raw = rows[0]?.overlay?.appearance?.defaults;
  const parsed = AppearancePreferencesSchema.safeParse(raw ?? {});
  return parsed.success && raw !== undefined ? parsed.data : null;
}

async function readAgents(kernel: Kernel) {
  const rows = await kernel.database
    .query<{ id: string; display_name: string; definition: { color?: string } }>(
      `SELECT id, display_name, definition FROM agent_definitions ORDER BY updated_at DESC LIMIT 50`,
    )
    .catch(() => []);
  if (rows.length > 0) {
    return rows.map((row, index) => ({
      id: row.id,
      displayName: row.display_name,
      color: row.definition.color ?? ['#3b6fd4', '#d9730d', '#2f8f6b'][index % 3] ?? '#3b6fd4',
    }));
  }
  const overlays = await kernel.database
    .query<{ overlay: { agents?: Record<string, { displayName?: string; color?: string }> } }>(
      `SELECT overlay FROM config_overlays ORDER BY version DESC LIMIT 1`,
    )
    .catch(() => []);
  const agents = overlays[0]?.overlay.agents ?? {};
  return Object.entries(agents).map(([id, agent]) => ({
    id,
    displayName: agent.displayName ?? id,
    color: agent.color ?? '#3b6fd4',
  }));
}

export function registerPreferenceRoutes(app: FastifyInstance, kernel: Kernel): void {
  app.get('/api/v1/me/preferences', async (request) => {
    const userId = request.principal?.userId ?? 'local-developer';
    const rows = await kernel.database.query<{ preferences: unknown }>(
      `SELECT preferences FROM user_preferences WHERE user_id = $1`,
      [userId],
    );
    const saved = PreferencesUpdateSchema.safeParse(rows[0]?.preferences ?? {});
    const defaults = await readDefaults(kernel);
    const base = saved.success ? saved.data : {};
    const preferences = PreferencesResponseSchema.parse({
      preferences: {
        ...(defaults ?? {}),
        ...base,
      },
      defaults,
      agents: await readAgents(kernel),
    });
    return preferences;
  });

  app.put('/api/v1/me/preferences', async (request) => {
    const userId = request.principal?.userId ?? 'local-developer';
    const body = PreferencesUpdateSchema.parse(request.body ?? {});
    const rows = await kernel.database.query<{ preferences: unknown }>(
      `SELECT preferences FROM user_preferences WHERE user_id = $1`,
      [userId],
    );
    const current = PreferencesUpdateSchema.safeParse(rows[0]?.preferences ?? {});
    const agents = body.agents;

    if (agents && agents.length > 0) {
      // Agent names/colours are instance-wide, so they are not a per-user
      // preference. The ANY route only accepts them from an admin (F5).
      if (request.principal?.role !== 'admin') {
        throw new AppError(
          'preferences.AGENTS_ADMIN_ONLY',
          'only admins may rename or recolour agents',
          undefined,
          403,
        );
      }
      const names = new Map<string, string>();
      for (const agent of agents) {
        const key = agent.displayName.trim().toLowerCase();
        const clash = names.get(key);
        if (clash && clash !== agent.id) {
          throw new AppError(
            'preferences.DUPLICATE_AGENT_NAME',
            `agent name "${agent.displayName}" is used more than once`,
            undefined,
            409,
          );
        }
        names.set(key, agent.id);
        await kernel.database.query(
          `UPDATE agent_definitions
              SET display_name = $2,
                  definition = jsonb_set(definition, '{color}', to_jsonb($3::text), true),
                  updated_at = now()
            WHERE id = $1`,
          [agent.id, agent.displayName, agent.color],
        );
      }
    }

    const next = {
      ...(current.success ? current.data : {}),
      ...body,
      ...(agents ? { agents } : {}),
    };
    await kernel.database.query(
      `INSERT INTO user_preferences (user_id, preferences, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE
         SET preferences = EXCLUDED.preferences, updated_at = now()`,
      [userId, next],
    );
    await writeAudit(kernel.database, {
      actor: request.principal?.email ?? userId,
      action: 'preferences.update',
      subject: userId,
      payload: { theme: next.theme, fontSize: next.fontSize, motion: next.motion },
    });
    const response: PreferencesResponse = await (async () => {
      const defaults = await readDefaults(kernel);
      return PreferencesResponseSchema.parse({
        preferences: { ...(defaults ?? {}), ...next },
        defaults,
        agents: await readAgents(kernel),
      });
    })();
    return response;
  });
}
