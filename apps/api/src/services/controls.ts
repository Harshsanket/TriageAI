/** Runtime kill switches (Phase 18.5): immediate, audited and visible. */
import type { Database } from '@triageai/kernel';

import { writeAudit } from './audit.js';

export interface Controls {
  agentsPaused: boolean;
  hostedModelsDisabled: boolean;
  readOnly: boolean;
  pluginInstallsBlocked: boolean;
  /** Global LLM kill switch (ADR-0058). */
  llmDisabled: boolean;
  /** Runtime ids (`<adapter>:<model>`) removed from selection. */
  disabledRuntimes: string[];
}

const DEFAULTS: Controls = {
  agentsPaused: false,
  hostedModelsDisabled: false,
  readOnly: false,
  pluginInstallsBlocked: false,
  llmDisabled: false,
  disabledRuntimes: [],
};

const KEY = 'controls';

export async function getControls(database: Database): Promise<Controls> {
  const rows = (await database
    .query<{ value: Partial<Controls> }>(`SELECT value FROM settings WHERE key = $1`, [KEY])
    .catch(() => [])) as Array<{ value: Partial<Controls> }>;
  return { ...DEFAULTS, ...(rows[0]?.value ?? {}) };
}

export async function setControls(
  database: Database,
  patch: Partial<Controls>,
  actor: string | null,
): Promise<Controls> {
  const current = await getControls(database);
  const next = { ...current, ...patch };
  await database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [KEY, next, actor],
  );
  await writeAudit(database, {
    actor,
    action: 'controls.updated',
    subject: KEY,
    payload: { before: current, after: next },
  });
  return next;
}

/** 32.2: turning every runtime off engages the global kill switch. */
export function resolveLlmSwitch<T extends Partial<Controls>>(patch: T, runtimeIds: string[]): T {
  if (!patch.disabledRuntimes || runtimeIds.length === 0) return patch;
  return runtimeIds.every((id) => patch.disabledRuntimes?.includes(id))
    ? { ...patch, llmDisabled: true }
    : patch;
}
