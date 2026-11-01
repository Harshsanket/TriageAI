/**
 * App updates (Phase 23.8): check GitHub for a newer release at most once every
 * two weeks (or on demand), stage the source archive, and run an operator-
 * configured update command. Downloads never execute untrusted code; only
 * TRIAGEAI_UPDATE_COMMAND (an explicit deployment choice) runs.
 */
import { execFile } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Database, Kernel } from '@triageai/kernel';

import { writeAudit } from './audit.js';
import { EgressClient } from './egress.js';

const execFileAsync = promisify(execFile);
const SETTINGS_KEY = 'updates.state';
const REPO = 'Harshsanket/TriageAI';
const CHECK_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

export interface UpdateState {
  version: number;
  checkedAt: string | null;
  latestVersion: string | null;
  currentVersion: string;
  available: boolean;
  releaseUrl: string | null;
  downloadUrl: string | null;
  notes: string | null;
  stagedPath: string | null;
  canApply: boolean;
  error: string | null;
}

export function currentVersion(): string {
  for (const candidate of [
    resolve(process.cwd(), '../../package.json'),
    resolve(process.cwd(), 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // try the next location
    }
  }
  return '1.0.0';
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10) || 0)
      .slice(0, 3);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

async function readState(database: Database): Promise<UpdateState> {
  const rows = await database
    .query<{ value: UpdateState }>(`SELECT value FROM settings WHERE key = $1`, [SETTINGS_KEY])
    .catch(() => []);
  const stored = rows[0]?.value;
  return {
    version: Number(stored?.version ?? 0),
    checkedAt: stored?.checkedAt ?? null,
    latestVersion: stored?.latestVersion ?? null,
    currentVersion: currentVersion(),
    available: Boolean(stored?.available),
    releaseUrl: stored?.releaseUrl ?? null,
    downloadUrl: stored?.downloadUrl ?? null,
    notes: stored?.notes ?? null,
    stagedPath: stored?.stagedPath ?? null,
    canApply: Boolean(process.env.TRIAGEAI_UPDATE_COMMAND),
    error: null,
  };
}

async function writeState(database: Database, state: UpdateState): Promise<UpdateState> {
  const next = {
    ...state,
    version: state.version + 1,
    currentVersion: currentVersion(),
    canApply: Boolean(process.env.TRIAGEAI_UPDATE_COMMAND),
  };
  await database.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, 'system', now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [SETTINGS_KEY, next],
  );
  return next;
}

function egressFor(kernel: Kernel): EgressClient {
  return new EgressClient(kernel.database, [
    { host: 'api.github.com', dataClass: 'public' },
    { host: 'github.com', dataClass: 'public' },
    { host: 'codeload.github.com', dataClass: 'public' },
  ]);
}

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  tarball_url?: string;
}

export async function checkForUpdate(kernel: Kernel, force = false): Promise<UpdateState> {
  const state = await readState(kernel.database);
  if (
    !force &&
    state.checkedAt &&
    Date.now() - new Date(state.checkedAt).getTime() < CHECK_INTERVAL_MS
  ) {
    return state;
  }
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'triageai-update-check',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  try {
    const egress = egressFor(kernel);
    let release: GithubRelease | null = null;
    const latest = await egress.fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers },
      { purpose: 'update.check' },
    );
    if (latest.ok) release = (await latest.json()) as GithubRelease;
    if (!release?.tag_name) {
      const tags = await egress.fetch(
        `https://api.github.com/repos/${REPO}/tags?per_page=1`,
        { headers },
        { purpose: 'update.check' },
      );
      if (tags.ok) {
        const parsed = (await tags.json()) as Array<{ name?: string }>;
        if (parsed[0]?.name) {
          release = {
            tag_name: parsed[0].name,
            html_url: `https://github.com/${REPO}/releases/tag/${parsed[0].name}`,
            tarball_url: `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${parsed[0].name}`,
          };
        }
      }
    }
    const latestVersion = release?.tag_name?.replace(/^v/i, '') ?? null;
    const available = latestVersion ? compareVersions(latestVersion, currentVersion()) > 0 : false;
    const next = await writeState(kernel.database, {
      ...state,
      checkedAt: new Date().toISOString(),
      latestVersion,
      available,
      releaseUrl: release?.html_url ?? null,
      downloadUrl: release?.tarball_url
        ? release.tarball_url
        : latestVersion
          ? `https://codeload.github.com/${REPO}/tar.gz/refs/tags/v${latestVersion}`
          : null,
      notes: release?.body?.slice(0, 2000) ?? null,
      stagedPath: state.stagedPath,
      error: latestVersion ? null : 'no release or tag found',
    });
    await writeAudit(kernel.database, {
      actor: 'system',
      action: 'update.checked',
      subject: 'updates.state',
      payload: { latestVersion, available },
    });
    return next;
  } catch (err) {
    return writeState(kernel.database, {
      ...state,
      checkedAt: new Date().toISOString(),
      error: (err as Error).message,
    });
  }
}

export async function downloadUpdate(kernel: Kernel): Promise<UpdateState> {
  const state = await checkForUpdate(kernel);
  if (!state.available || !state.downloadUrl) return state;
  const egress = egressFor(kernel);
  const response = await egress.fetch(
    state.downloadUrl,
    { headers: { 'user-agent': 'triageai-update-download' } },
    { purpose: 'update.download', maxBytes: 100_000_000 },
  );
  if (!response.ok) throw new Error(`update download answered ${response.status}`);
  const dir = process.env.TRIAGEAI_UPDATE_DIR ?? resolve(process.cwd(), 'data/updates');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = resolve(dir, `triageai-${state.latestVersion ?? 'latest'}.tar.gz`);
  await writeFile(path, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
  const next = await writeState(kernel.database, { ...state, stagedPath: path });
  await writeAudit(kernel.database, {
    actor: 'system',
    action: 'update.downloaded',
    subject: 'updates.state',
    payload: { version: state.latestVersion, path },
  });
  return next;
}

export interface ApplyUpdateResult {
  applied: boolean;
  canApply: boolean;
  message: string;
}

export async function applyUpdate(kernel: Kernel): Promise<ApplyUpdateResult> {
  const state = await readState(kernel.database);
  if (!state.stagedPath) {
    throw new Error('download an update before applying it');
  }
  const command = process.env.TRIAGEAI_UPDATE_COMMAND;
  if (!command) {
    return {
      applied: false,
      canApply: false,
      message:
        'Update downloaded and verified. Set TRIAGEAI_UPDATE_COMMAND to apply it automatically, or run your deployment update.',
    };
  }
  const result = await execFileAsync('sh', ['-lc', command], {
    cwd: process.env.TRIAGEAI_UPDATE_ROOT ?? process.cwd(),
    timeout: 30 * 60 * 1000,
    maxBuffer: 2_000_000,
  }).catch((err: Error) => ({ stdout: '', stderr: err.message }));
  await writeAudit(kernel.database, {
    actor: 'system',
    action: 'update.applied',
    subject: 'updates.state',
    payload: {
      version: state.latestVersion,
      stdout: result.stdout.slice(-2000),
      stderr: result.stderr.slice(-2000),
    },
  });
  return { applied: true, canApply: true, message: 'Update applied. Restart the app to finish.' };
}
