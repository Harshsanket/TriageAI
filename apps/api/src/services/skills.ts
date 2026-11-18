/**
 * User skills (ADR-0060): owner-scoped, content-only instructions merged with
 * the built-in SKILL.md pack, imported from GitHub through egress and mirrored
 * into managed read-only KB sources. Nothing here executes skill content.
 */
import { ulid } from 'ulid';

import {
  AppError,
  capturePreference,
  loadSkillPack,
  parseSkillMarkdown,
  readSkill,
  skillMarkdown,
  slugifySkillName,
  type SkillDocument,
} from '@triageai/kernel';
import type { Database, Kernel, KernelRouteDef } from '@triageai/kernel';

import type {
  SkillCaptureResult,
  SkillCreateRequest,
  SkillImportRequestSchema,
  SkillListResponse,
  SkillUpdateRequest,
  UserSkill,
} from '@triageai/contracts';
import type { z } from 'zod';

import { EgressClient } from './egress.js';
import { writeAudit } from './audit.js';

interface SkillRow {
  [key: string]: unknown;
  id: string;
  owner_id: string | null;
  scope: 'user' | 'instance' | 'agent';
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  version: number;
  provenance: UserSkill['provenance'];
  source_url: string | null;
  source_ref: string | null;
  license: string | null;
  suggestion: boolean;
  ignored: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SECRET_LIKE =
  /(?:bearer\s+[a-z0-9._-]{8,}|api[_-]?key\s*[:=]|password\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;
const EMAIL = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;

export const DEFAULT_SKILL_SOURCES = [
  {
    name: 'docs-internal',
    repo: 'Harshsanket/docs-internal',
    license: 'see repository',
    url: 'https://github.com/Harshsanket/docs-internal',
  },
  {
    name: 'matt-pocock-skills',
    repo: 'mattpocock/skills',
    license: 'see repository',
    url: 'https://github.com/mattpocock/skills',
  },
  {
    name: 'poteto-noodles',
    repo: 'poteto/noodles',
    license: 'see repository',
    url: 'https://github.com/poteto/noodles',
  },
  {
    name: 'cursor-pstack',
    repo: 'cursor/pstack',
    license: 'see repository',
    url: 'https://github.com/cursor/pstack',
  },
] as const;

function dto(row: SkillRow): UserSkill {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scope: row.scope,
    name: row.name,
    description: row.description,
    content: row.content,
    enabled: row.enabled,
    version: Number(row.version),
    provenance: row.provenance,
    sourceUrl: row.source_url,
    sourceRef: row.source_ref,
    license: row.license,
    suggestion: row.suggestion,
    ignored: row.ignored,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function scrub(text: string): string {
  return text.replace(EMAIL, '[email]').replace(SECRET_LIKE, '[redacted]').trim();
}

export async function listUserSkills(
  database: Database,
  actorId: string | null,
  role: string | undefined,
  opts: { includeSuggestions?: boolean } = {},
): Promise<UserSkill[]> {
  const rows = await database.query<SkillRow>(
    `SELECT * FROM user_skills
      WHERE ($1::text IS NULL OR owner_id = $1 OR owner_id IS NULL)
        AND NOT ignored
      ORDER BY suggestion DESC, updated_at DESC LIMIT 200`,
    [role === 'admin' ? null : (actorId ?? null)],
  );
  return rows.filter((row) => (opts.includeSuggestions ? true : !row.suggestion)).map(dto);
}

async function visibleSkill(
  database: Database,
  id: string,
  actorId: string | null,
  role: string | undefined,
): Promise<SkillRow | null> {
  // Admins may edit any row, including instance-wide skills. Everyone else may
  // only touch rows they own; `owner_id IS NULL` is never implicitly visible
  // (F2: a customer must not edit or delete an instance skill).
  if (role === 'admin') {
    const rows = await database.query<SkillRow>(`SELECT * FROM user_skills WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
  if (!actorId) return null;
  const rows = await database.query<SkillRow>(
    `SELECT * FROM user_skills WHERE id = $1 AND owner_id = $2`,
    [id, actorId],
  );
  return rows[0] ?? null;
}

function requireAdminForInstance(role: string | undefined, action: string): void {
  if (role !== 'admin') {
    throw new AppError('FORBIDDEN', `only admins may ${action} an instance skill`, undefined, 403);
  }
}

export async function listSkillIndex(
  database: Database,
  skillsRoot: string,
  actorId: string | null,
  role: string | undefined,
): Promise<SkillListResponse> {
  const [builtIn, skills] = await Promise.all([
    loadSkillPack(skillsRoot).catch(() => []),
    listUserSkills(database, actorId, role, { includeSuggestions: true }),
  ]);
  return {
    builtIn: builtIn.map((entry) => ({ name: entry.name, description: entry.description })),
    skills: skills.filter((skill) => !skill.suggestion),
    suggestions: skills.filter((skill) => skill.suggestion),
  };
}

export async function readSkillDocument(
  database: Database,
  skillsRoot: string,
  idOrName: string,
  actorId: string | null,
  role: string | undefined,
): Promise<{ name: string; description: string; content: string; source: string } | null> {
  const rows = await database.query<SkillRow>(
    `SELECT * FROM user_skills
      WHERE (id = $1 OR name = $1) AND ($2::text IS NULL OR owner_id = $2 OR owner_id IS NULL)
      ORDER BY enabled DESC, updated_at DESC LIMIT 1`,
    [idOrName, role === 'admin' ? null : (actorId ?? null)],
  );
  const row = rows[0];
  if (row) {
    return {
      name: row.name,
      description: row.description,
      content: row.content,
      source: row.provenance,
    };
  }
  try {
    const skill: SkillDocument = await readSkill(skillsRoot, idOrName);
    return {
      name: skill.name,
      description: skill.description,
      content: skill.body,
      source: 'built-in',
    };
  } catch {
    return null;
  }
}

async function upsertSkill(
  kernel: Kernel,
  args: {
    ownerId: string | null;
    name: string;
    description: string;
    content: string;
    scope: 'user' | 'instance' | 'agent';
    enabled: boolean;
    provenance: UserSkill['provenance'];
    sourceUrl?: string | null;
    sourceRef?: string | null;
    license?: string | null;
    suggestion?: boolean;
    actor: string;
  },
): Promise<{ skill: UserSkill; created: boolean }> {
  const existing = await kernel.database.query<SkillRow>(
    `SELECT * FROM user_skills WHERE COALESCE(owner_id, '') = $1 AND name = $2 LIMIT 1`,
    [args.ownerId ?? '', args.name],
  );
  if (existing[0]) {
    const row = existing[0];
    if (
      row.content === args.content &&
      row.description === args.description &&
      row.source_url === (args.sourceUrl ?? null) &&
      row.source_ref === (args.sourceRef ?? null)
    ) {
      return { skill: dto(row), created: false };
    }
    const updated = await kernel.database.query<SkillRow>(
      `UPDATE user_skills
          SET description = $2, content = $3, enabled = $4, scope = $5, version = version + 1,
              provenance = $6, source_url = $7, source_ref = $8, license = $9,
              suggestion = false, ignored = false, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        row.id,
        args.description,
        args.content,
        args.enabled,
        args.scope,
        args.provenance,
        args.sourceUrl ?? null,
        args.sourceRef ?? null,
        args.license ?? null,
      ],
    );
    const skill = dto(updated[0] as SkillRow);
    await writeAudit(kernel.database, {
      actor: args.actor,
      action: 'skill.update',
      subject: skill.id,
      payload: { name: skill.name, version: skill.version },
    });
    await syncSkillMirror(kernel);
    return { skill, created: false };
  }
  const id = ulid();
  const created = await kernel.database.query<SkillRow>(
    `INSERT INTO user_skills
       (id, owner_id, scope, name, description, content, enabled, provenance,
        source_url, source_ref, license, suggestion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      id,
      args.ownerId,
      args.scope,
      args.name,
      args.description,
      args.content,
      args.enabled,
      args.provenance,
      args.sourceUrl ?? null,
      args.sourceRef ?? null,
      args.license ?? null,
      args.suggestion ?? false,
    ],
  );
  const skill = dto(created[0] as SkillRow);
  await writeAudit(kernel.database, {
    actor: args.actor,
    action: 'skill.create',
    subject: skill.id,
    payload: { name: skill.name, provenance: skill.provenance, suggestion: skill.suggestion },
  });
  if (!skill.suggestion) await syncSkillMirror(kernel);
  return { skill, created: true };
}

export async function createSkill(
  kernel: Kernel,
  actorId: string | null,
  role: string | undefined,
  input: SkillCreateRequest,
  actor: string,
): Promise<UserSkill> {
  if (input.scope === 'instance') requireAdminForInstance(role, 'create');
  const name =
    input.name ?? slugifySkillName(input.description, `skill-${Date.now().toString(36)}`);
  if (!NAME.test(name)) throw new Error('invalid skill name');
  const description = scrub(input.description);
  const instructions = scrub(input.instructions);
  if (SECRET_LIKE.test(input.instructions)) {
    throw new Error('skill content looks like a secret; remove secrets before saving');
  }
  const content = instructions.includes('---')
    ? instructions
    : skillMarkdown(name, description, instructions);
  const result = await upsertSkill(kernel, {
    ownerId: input.scope === 'instance' ? null : (actorId ?? null),
    name,
    description,
    content,
    scope: input.scope ?? 'user',
    enabled: input.enabled ?? true,
    provenance: 'custom',
    actor,
  });
  return result.skill;
}

export async function updateSkill(
  kernel: Kernel,
  id: string,
  actorId: string | null,
  role: string | undefined,
  patch: SkillUpdateRequest,
  actor: string,
): Promise<UserSkill | null> {
  const row = await visibleSkill(kernel.database, id, actorId, role);
  if (!row) return null;
  if (patch.scope === 'instance') requireAdminForInstance(role, 'promote');
  const next = {
    name: patch.name ?? row.name,
    description: patch.description ?? row.description,
    content:
      patch.instructions === undefined
        ? row.content
        : patch.instructions.includes('---')
          ? patch.instructions
          : skillMarkdown(
              patch.name ?? row.name,
              patch.description ?? row.description,
              patch.instructions,
            ),
    enabled: patch.enabled ?? row.enabled,
    scope: patch.scope ?? row.scope,
  };
  if (SECRET_LIKE.test(next.content)) {
    throw new Error('skill content looks like a secret; remove secrets before saving');
  }
  const updated = await kernel.database.query<SkillRow>(
    `UPDATE user_skills
        SET name = $2, description = $3, content = $4, enabled = $5, scope = $6,
            suggestion = false, version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [row.id, next.name, next.description, next.content, next.enabled, next.scope],
  );
  await writeAudit(kernel.database, {
    actor,
    action: 'skill.update',
    subject: row.id,
    payload: { name: next.name, enabled: next.enabled },
  });
  await syncSkillMirror(kernel);
  return updated[0] ? dto(updated[0]) : null;
}

export async function deleteSkill(
  kernel: Kernel,
  id: string,
  actorId: string | null,
  role: string | undefined,
  actor: string,
): Promise<boolean> {
  const row = await visibleSkill(kernel.database, id, actorId, role);
  if (!row) return false;
  await kernel.database.query(`DELETE FROM user_skills WHERE id = $1`, [id]);
  await writeAudit(kernel.database, {
    actor,
    action: 'skill.delete',
    subject: id,
    payload: { name: row.name },
  });
  await syncSkillMirror(kernel);
  return true;
}

export async function resolveSuggestion(
  kernel: Kernel,
  id: string,
  actorId: string | null,
  role: string | undefined,
  action: 'accept' | 'ignore',
  actor: string,
): Promise<UserSkill | null> {
  const row = await visibleSkill(kernel.database, id, actorId, role);
  if (!row || !row.suggestion) return null;
  if (action === 'ignore') {
    await kernel.database.query(
      `UPDATE user_skills SET ignored = true, updated_at = now() WHERE id = $1`,
      [id],
    );
    await writeAudit(kernel.database, {
      actor,
      action: 'skill.suggestion_ignore',
      subject: id,
      payload: { name: row.name },
    });
    return null;
  }
  const updated = await kernel.database.query<SkillRow>(
    `UPDATE user_skills
        SET suggestion = false, enabled = true, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id],
  );
  await writeAudit(kernel.database, {
    actor,
    action: 'skill.suggestion_accept',
    subject: id,
    payload: { name: row.name },
  });
  await syncSkillMirror(kernel);
  return updated[0] ? dto(updated[0]) : null;
}

const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The subset of the egress client pinning needs; tests inject a fake. */
export type SkillSourceFetcher = Pick<EgressClient, 'fetch'>;

export interface ParsedSkillSource {
  owner: string;
  repo: string;
  path: string;
  /** Branch/tag/commit from the URL; null means "try the default branches". */
  ref: string | null;
  /** The URL already names a full 40-character commit. */
  pinned: boolean;
}

function safeSegment(value: string, label: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new AppError('skills.INVALID', `unsafe ${label} in skill source URL`, undefined, 400);
  }
  return value;
}

function safeSkillPath(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new AppError(
      'skills.INVALID',
      'skill source path is not valid URL encoding',
      undefined,
      400,
    );
  }
  if (decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new AppError('skills.INVALID', 'unsafe skill source path', undefined, 400);
  }
  const segments = decoded.split('/');
  if (segments.length === 0 || segments.some((segment) => !SAFE_SEGMENT.test(segment))) {
    throw new AppError('skills.INVALID', 'unsafe skill source path', undefined, 400);
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    throw new AppError(
      'skills.INVALID',
      'path traversal is not allowed in skill sources',
      undefined,
      400,
    );
  }
  if (!/\.md$/i.test(decoded)) {
    throw new AppError(
      'skills.INVALID',
      'skill source must point to a Markdown file',
      undefined,
      400,
    );
  }
  return segments.join('/');
}

/** Parse a GitHub repository, `blob/<ref>/<path>` or raw SKILL.md URL. */
export function parseSkillSourceUrl(url: string): ParsedSkillSource {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname === 'raw.githubusercontent.com') {
    const [owner, repo, ref, ...pathParts] = parts;
    if (!owner || !repo || !ref || pathParts.length === 0) {
      throw new AppError('skills.INVALID', 'URL must point to a SKILL.md file', undefined, 400);
    }
    return {
      owner: safeSegment(owner, 'owner'),
      repo: safeSegment(repo, 'repository'),
      path: safeSkillPath(pathParts.join('/')),
      ref: safeSegment(ref, 'ref'),
      pinned: COMMIT_SHA.test(ref),
    };
  }
  if (parsed.hostname !== 'github.com') {
    throw new AppError(
      'skills.INVALID',
      'only github.com or raw.githubusercontent.com URLs are supported',
      undefined,
      400,
    );
  }
  const [owner, repo, kind, ref, ...rest] = parts;
  if (!owner || !repo) {
    throw new AppError(
      'skills.INVALID',
      'URL must point to a repository or SKILL.md',
      undefined,
      400,
    );
  }
  if (kind === undefined) {
    return {
      owner: safeSegment(owner, 'owner'),
      repo: safeSegment(repo, 'repository'),
      path: 'SKILL.md',
      ref: null,
      pinned: false,
    };
  }
  if (kind !== 'blob' || !ref || rest.length === 0) {
    throw new AppError(
      'skills.INVALID',
      'URL must point to a repository or a blob/<ref>/SKILL.md path',
      undefined,
      400,
    );
  }
  return {
    owner: safeSegment(owner, 'owner'),
    repo: safeSegment(repo, 'repository'),
    path: safeSkillPath(rest.join('/')),
    ref: safeSegment(ref, 'ref'),
    pinned: COMMIT_SHA.test(ref),
  };
}

export interface SkillSourceCandidate {
  rawUrl: string;
  /** Full commit SHA the content is read at; stored as `source_ref`. */
  sha: string;
  ref: string | null;
}

async function resolveSkillCommit(
  client: SkillSourceFetcher,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  const response = await client.fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    { method: 'GET', headers: { accept: 'application/vnd.github+json' } },
    { purpose: 'skill-pin', maxBytes: 200_000 },
  );
  if (!response.ok) throw new Error(`GitHub could not resolve ${ref} (${response.status})`);
  const body = (await response.json().catch(() => null)) as { sha?: unknown } | null;
  if (typeof body?.sha !== 'string' || !COMMIT_SHA.test(body.sha)) {
    throw new Error(`GitHub returned no commit SHA for ${ref}`);
  }
  return body.sha.toLowerCase();
}

/**
 * Resolve a skill URL to immutable commit candidates (15.T5). A `blob/<sha>/`
 * URL is already pinned; a branch/tag is resolved through the GitHub API so a
 * re-import can prove the source has not moved.
 */
export async function skillSourceCandidates(
  url: string,
  client: SkillSourceFetcher,
): Promise<SkillSourceCandidate[]> {
  const source = parseSkillSourceUrl(url);
  const refs = source.ref ? [source.ref] : ['main', 'master'];
  const candidates: SkillSourceCandidate[] = [];
  let lastError: unknown;
  for (const ref of refs) {
    try {
      const sha = source.pinned
        ? (source.ref as string).toLowerCase()
        : await resolveSkillCommit(client, source.owner, source.repo, ref);
      candidates.push({
        rawUrl: `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${sha}/${source.path}`,
        sha,
        ref: source.ref,
      });
    } catch (err) {
      lastError = err;
    }
  }
  if (candidates.length === 0) {
    throw new AppError(
      'skills.INVALID',
      `could not resolve ${url}: ${(lastError as Error)?.message ?? 'not found'}`,
      undefined,
      400,
    );
  }
  return candidates;
}

export async function importSkillFromGithub(
  kernel: Kernel,
  actorId: string | null,
  input: z.infer<typeof SkillImportRequestSchema>,
  actor: string,
  fetcher?: SkillSourceFetcher,
): Promise<UserSkill> {
  const allow = [...(kernel.config.egress?.allowlist ?? [])];
  const client =
    fetcher ??
    new EgressClient(kernel.database, [
      ...allow,
      { host: 'raw.githubusercontent.com', dataClass: 'public' },
      { host: 'github.com', dataClass: 'public' },
      { host: 'api.github.com', dataClass: 'public' },
    ]);
  const candidates = await skillSourceCandidates(input.url, client);
  const update = input.update ?? false;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const response = await client.fetch(
        candidate.rawUrl,
        { method: 'GET', headers: { accept: 'text/plain' } },
        { purpose: 'skill-import', maxBytes: 100_000 },
      );
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const text = await response.text();
      if (text.length > 100_000) throw new Error('SKILL.md exceeds the 100 KB limit');
      const parsed = parseSkillMarkdown(text, candidate.rawUrl);
      const content = skillMarkdown(parsed.name, parsed.description, parsed.body);
      if (SECRET_LIKE.test(content)) {
        throw new Error('imported skill looks like it contains a secret');
      }
      const existing = await kernel.database.query<SkillRow>(
        `SELECT * FROM user_skills
          WHERE COALESCE(owner_id, '') = $1 AND name = $2 AND provenance = 'github'
          LIMIT 1`,
        [actorId ?? '', parsed.name],
      );
      const previous = existing[0];
      if (previous?.source_url === input.url && COMMIT_SHA.test(previous.source_ref ?? '')) {
        if (previous.source_ref !== candidate.sha && !update) {
          throw new AppError(
            'skills.SOURCE_MOVED',
            `skill ${parsed.name} is pinned at ${previous.source_ref}, but ${input.url} now resolves to ${candidate.sha}; re-import with update=true to move the pin`,
            { from: previous.source_ref, to: candidate.sha },
            409,
          );
        }
        if (previous.source_ref === candidate.sha && previous.content === content) {
          return dto(previous);
        }
      }
      const result = await upsertSkill(kernel, {
        ownerId: actorId,
        name: parsed.name,
        description: scrub(parsed.description),
        content,
        scope: 'user',
        enabled: false,
        provenance: 'github',
        sourceUrl: input.url,
        sourceRef: candidate.sha,
        license: null,
        actor,
      });
      await writeAudit(kernel.database, {
        actor,
        action: 'skill.import',
        subject: result.skill.id,
        payload: {
          url: input.url,
          ref: result.skill.sourceRef,
          pinned: true,
          updated: update,
        },
      });
      return result.skill;
    } catch (err) {
      if (err instanceof AppError && err.code === 'skills.SOURCE_MOVED') throw err;
      lastError = err;
    }
  }
  throw new AppError(
    'skills.IMPORT_FAILED',
    `could not import a SKILL.md from ${input.url}: ${(lastError as Error)?.message ?? 'not found'}`,
    undefined,
    400,
  );
}

/** Import one content-only skill from a signed pack (22.T12). */
export async function importSkillFromPack(
  kernel: Kernel,
  args: {
    ownerId: string | null;
    name: string;
    description: string;
    body: string;
    sourceUrl: string;
    sourceRef: string;
    license: string | null;
    actor: string;
  },
): Promise<UserSkill> {
  if (!NAME.test(args.name)) {
    throw new AppError('skills.INVALID', `invalid skill name "${args.name}"`, undefined, 400);
  }
  let description = scrub(args.description);
  if (description.length < 10) {
    const firstLine = scrub(args.body)
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find((line) => line.length >= 10);
    description = (firstLine ?? `${args.name} imported from a signed pack`).slice(0, 300);
  }
  description = description.slice(0, 400);
  const content = skillMarkdown(args.name, description, args.body);
  if (SECRET_LIKE.test(content)) {
    throw new AppError(
      'skills.INVALID',
      'imported skill looks like it contains a secret',
      undefined,
      400,
    );
  }
  const result = await upsertSkill(kernel, {
    ownerId: args.ownerId,
    name: args.name,
    description,
    content,
    scope: 'user',
    enabled: false,
    // The immutable `user_skills` check constraint predates packs, so imported
    // pack content reuses the external-source provenance. `sourceUrl` records
    // `pack:<id>@<version>` and `sourceRef` the archive sha256.
    provenance: 'github',
    sourceUrl: args.sourceUrl,
    sourceRef: args.sourceRef,
    license: args.license,
    actor: args.actor,
  });
  await writeAudit(kernel.database, {
    actor: args.actor,
    action: 'skill.import',
    subject: result.skill.id,
    payload: { source: 'pack', ref: args.sourceRef },
  });
  return result.skill;
}

export const captureSkillPreference = capturePreference;

export async function captureChatSkill(
  kernel: Kernel,
  actorId: string | null,
  text: string,
  actor: string,
): Promise<SkillCaptureResult> {
  const captured = captureSkillPreference(text);
  if (!captured) return { captured: false, kind: 'none', skill: null, notice: null };
  const name = slugifySkillName(
    captured.instruction.split(/\s+/).slice(0, 6).join(' '),
    'chat-preference',
  );
  const description = scrub(captured.instruction).slice(0, 300);
  const content = skillMarkdown(
    name,
    description,
    `When responding:\n- ${scrub(captured.instruction)}`,
  );
  const result = await upsertSkill(kernel, {
    ownerId: actorId,
    name,
    description,
    content,
    scope: 'user',
    enabled: captured.kind === 'explicit',
    provenance: 'chat',
    suggestion: captured.kind === 'suggestion',
    actor,
  });
  if (!result.created) {
    return {
      captured: false,
      kind: captured.kind,
      skill: result.skill,
      notice: `Skill “${result.skill.name}” is already saved.`,
    };
  }
  return {
    captured: true,
    kind: captured.kind,
    skill: result.skill,
    notice:
      captured.kind === 'explicit' ? `Added skill: ${result.skill.name} · Manage in Skills` : null,
  };
}

/** Read the enabled instructions a model may see (owner + instance, never suggestions). */
export async function enabledSkillInstructions(
  database: Database,
  actorId: string | null,
): Promise<Array<{ name: string; version: number; content: string }>> {
  const rows = await database.query<SkillRow>(
    `SELECT name, version, content FROM user_skills
      WHERE enabled AND NOT suggestion AND NOT ignored
        AND (owner_id = $1 OR owner_id IS NULL)
      ORDER BY name LIMIT 50`,
    [actorId],
  );
  return rows.map((row) => ({
    name: row.name,
    version: Number(row.version),
    content: row.content,
  }));
}

function kbRoute(kernel: Kernel, method: KernelRouteDef['method'], url: string) {
  return kernel.routes().find((entry) => entry.method === method && entry.url === url);
}

/**
 * Mirror enabled skills into managed, read-only operator KB sources. The skill
 * store stays authoritative; old versions and deleted skills are removed.
 */
export async function syncSkillMirror(kernel: Kernel): Promise<void> {
  if (!kernel.modules.includes('kb')) return;
  const upsert = kbRoute(kernel, 'POST', '/api/v1/kb/managed');
  const list = kbRoute(kernel, 'GET', '/api/v1/kb/sources');
  const remove = kbRoute(kernel, 'DELETE', '/api/v1/kb/sources/:id');
  if (!upsert || !list || !remove) return;
  const rows = await kernel.database.query<SkillRow>(
    `SELECT * FROM user_skills WHERE enabled AND NOT suggestion AND NOT ignored ORDER BY name`,
  );
  const desired = new Map(
    rows.map((row) => [`skill:${row.owner_id ?? 'instance'}:${row.name}@${row.version}`, row]),
  );
  try {
    const existing = (await list.handler({
      method: 'GET',
      url: list.url,
      params: {},
      query: {},
      body: {},
      actor: 'system:skills',
    })) as { sources?: Array<{ id: string; managedKey?: string | null }> };
    for (const source of existing.sources ?? []) {
      if (!source.managedKey?.startsWith('skill:')) continue;
      if (desired.has(source.managedKey)) continue;
      await remove.handler({
        method: 'DELETE',
        url: remove.url,
        params: { id: source.id },
        query: {},
        body: {},
        actor: 'system:skills',
      });
    }
    for (const [key, row] of desired) {
      await upsert.handler({
        method: 'POST',
        url: upsert.url,
        params: {},
        query: {},
        actor: 'system:skills',
        body: {
          managedKey: key,
          title: `Skill: ${row.name}`,
          label: 'Skill',
          body: [`# ${row.name}`, '', row.description, '', row.content].join('\n'),
          audience: 'operator',
          sensitivity: 'internal',
          readOnly: true,
        },
      });
    }
  } catch {
    // A mirror failure never fails the skill write; the next sync retries.
  }
}

/**
 * 27.T8: discover SKILL.md files in a default source repository and import
 * each one pinned to its resolved commit. Unavailable sources warn; boot never
 * blocks. The fetcher is injectable for tests.
 */
export async function discoverSkillPaths(
  repo: string,
  fetcher: SkillSourceFetcher,
  ref = 'main',
): Promise<string[]> {
  const response = await fetcher.fetch(
    `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`,
    { method: 'GET', headers: { accept: 'application/vnd.github+json' } },
    { purpose: 'skill-discovery', maxBytes: 1_000_000 },
  );
  if (!response.ok) throw new Error(`GitHub tree answered ${response.status}`);
  const body = (await response.json()) as {
    tree?: Array<{ path?: string; type?: string }>;
  };
  return (body.tree ?? [])
    .filter((entry) => entry.type === 'blob' && entry.path?.endsWith('SKILL.md'))
    .map((entry) => entry.path as string)
    .slice(0, 200);
}

export async function syncDefaultSkillSources(
  kernel: Kernel,
  options: {
    fetcher?: SkillSourceFetcher;
    logger?: { warn(fields: Record<string, unknown>, message?: string): void };
  } = {},
): Promise<{ imported: number; failed: number }> {
  const allow = [...(kernel.config.egress?.allowlist ?? [])];
  const fetcher =
    options.fetcher ??
    new EgressClient(kernel.database, [
      ...allow,
      { host: 'raw.githubusercontent.com', dataClass: 'public' },
      { host: 'github.com', dataClass: 'public' },
      { host: 'api.github.com', dataClass: 'public' },
    ]);
  const logger = options.logger ?? {
    warn: (fields: Record<string, unknown>, message?: string) =>
      console.warn(message ?? 'skill boot sync', fields),
  };
  let imported = 0;
  let failed = 0;
  for (const source of DEFAULT_SKILL_SOURCES) {
    let paths: string[] = [];
    let ref = '';
    for (const candidate of ['main', 'master']) {
      try {
        paths = await discoverSkillPaths(source.repo, fetcher, candidate);
        ref = candidate;
        break;
      } catch (err) {
        logger.warn(
          { source: source.name, ref: candidate, err: (err as Error).message },
          'default skill source unavailable',
        );
      }
    }
    for (const path of paths) {
      try {
        await importSkillFromGithub(
          kernel,
          null,
          { url: `https://github.com/${source.repo}/blob/${ref}/${path}`, update: false },
          'system:boot',
          fetcher,
        );
        imported += 1;
      } catch (err) {
        failed += 1;
        logger.warn(
          { source: source.name, path, err: (err as Error).message },
          'default skill import failed',
        );
      }
    }
  }
  return { imported, failed };
}
