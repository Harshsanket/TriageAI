/**
 * User skills (ADR-0060): owner-scoped, content-only instructions merged with
 * the built-in SKILL.md pack, imported from GitHub through egress and mirrored
 * into managed read-only KB sources. Nothing here executes skill content.
 */
import { ulid } from 'ulid';

import {
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
  const rows = await database.query<SkillRow>(
    `SELECT * FROM user_skills
      WHERE id = $1 AND ($2::text IS NULL OR owner_id = $2 OR owner_id IS NULL)`,
    [id, role === 'admin' ? null : (actorId ?? null)],
  );
  return rows[0] ?? null;
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
    if (row.content === args.content && row.description === args.description) {
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
  input: SkillCreateRequest,
  actor: string,
): Promise<UserSkill> {
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

function rawUrls(url: string): Array<{ url: string; ref: string }> {
  const parsed = new URL(url);
  if (parsed.hostname === 'raw.githubusercontent.com') {
    const parts = parsed.pathname.split('/').filter(Boolean);
    const ref = parts[2] ?? 'pinned';
    return [{ url, ref }];
  }
  if (parsed.hostname !== 'github.com') {
    throw new Error('only github.com or raw.githubusercontent.com URLs are supported');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const [owner, repo, kind, ref, ...rest] = parts;
  if (!owner || !repo) throw new Error('URL must point to a repository or SKILL.md');
  if (kind === 'blob') {
    const path = rest.join('/');
    return [
      {
        url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`,
        ref: ref ?? 'pinned',
      },
    ];
  }
  return ['main', 'master'].map((branch) => ({
    url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/SKILL.md`,
    ref: branch,
  }));
}

export async function importSkillFromGithub(
  kernel: Kernel,
  actorId: string | null,
  input: z.infer<typeof SkillImportRequestSchema>,
  actor: string,
): Promise<UserSkill> {
  const allow = [...(kernel.config.egress?.allowlist ?? [])];
  const client = new EgressClient(kernel.database, [
    ...allow,
    { host: 'raw.githubusercontent.com', dataClass: 'public' },
    { host: 'github.com', dataClass: 'public' },
  ]);
  let lastError: unknown;
  for (const candidate of rawUrls(input.url)) {
    try {
      const response = await client.fetch(
        candidate.url,
        { method: 'GET', headers: { accept: 'text/plain' } },
        { purpose: 'skill-import', maxBytes: 100_000 },
      );
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const text = await response.text();
      if (text.length > 100_000) throw new Error('SKILL.md exceeds the 100 KB limit');
      const parsed = parseSkillMarkdown(text, candidate.url);
      const etag = response.headers.get('etag');
      const content = skillMarkdown(parsed.name, parsed.description, parsed.body);
      if (SECRET_LIKE.test(content)) {
        throw new Error('imported skill looks like it contains a secret');
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
        sourceRef: etag ?? candidate.ref,
        license: null,
        actor,
      });
      await writeAudit(kernel.database, {
        actor,
        action: 'skill.import',
        subject: result.skill.id,
        payload: { url: input.url, ref: result.skill.sourceRef },
      });
      return result.skill;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `could not import a SKILL.md from ${input.url}: ${(lastError as Error)?.message ?? 'not found'}`,
  );
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
