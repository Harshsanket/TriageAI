/**
 * Deterministic routine probes (18.T33). A probe reads a watermark with no
 * model call; the scheduler compares it with `schedule_state.watermark`.
 *
 * Built-in reads are deliberately generic (the kernel has no use-case
 * vocabulary):
 *   table:<table>:max:<column>   latest value (text)
 *   table:<table>:count          row count
 *   workflow:<id>:last_finished_at
 *   setting:<key>                stored settings value
 *
 * Modules may register custom readers by exact `read` string through
 * `SchedulerOptions.probeReaders` (tests use this; a module-provided registry
 * is the natural follow-up if a probe needs a domain query).
 */
import { invalid } from '../errors.js';
import type { Database } from '../types.js';

export type ProbeReader = () => Promise<unknown>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw invalid(`probe ${what} "${value}" is not a plain identifier`);
  }
  return `"${value}"`;
}

export async function readProbeWatermark(
  database: Database,
  read: string,
  readers: Record<string, ProbeReader> = {},
): Promise<unknown> {
  const custom = readers[read];
  if (custom) return custom();

  const parts = read.split(':');
  if (parts[0] === 'table' && parts[1]) {
    const table = identifier(parts[1], 'table');
    if (parts[2] === 'count') {
      const rows = await database.query<{ value: string }>(
        `SELECT count(*)::text AS value FROM ${table}`,
      );
      return rows[0]?.value ?? '0';
    }
    if (parts[2] === 'max' && parts[3]) {
      const column = identifier(parts[3], 'column');
      const rows = await database.query<{ value: string | null }>(
        `SELECT max(${column})::text AS value FROM ${table}`,
      );
      return rows[0]?.value ?? null;
    }
  }
  if (parts[0] === 'workflow' && parts[1] && parts[2] === 'last_finished_at') {
    const rows = await database.query<{ value: string | null }>(
      `SELECT max(finished_at)::text AS value FROM workflow_runs WHERE workflow_id = $1`,
      [parts[1]],
    );
    return rows[0]?.value ?? null;
  }
  if (parts[0] === 'setting' && parts[1]) {
    const rows = await database.query<{ value: unknown }>(
      `SELECT value FROM settings WHERE key = $1`,
      [parts[1]],
    );
    return rows[0]?.value ?? null;
  }
  throw invalid(`unknown probe read "${read}"`);
}

/** Stored watermark rows use `{ value }` so a null read is distinguishable. */
export function watermarkValue(stored: unknown): unknown {
  if (stored && typeof stored === 'object' && 'value' in stored) {
    return (stored as { value: unknown }).value;
  }
  return stored ?? null;
}
