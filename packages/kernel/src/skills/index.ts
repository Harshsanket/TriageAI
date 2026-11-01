/**
 * Skills (Phase 15, ADR-0030): content-only instruction packs. Only name +
 * description sit in an agent's prompt; the body loads on demand through
 * `skill.load`. Bundled scripts are never executed.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { AppError, notFound } from '../errors.js';

export interface SkillIndexEntry {
  name: string;
  description: string;
  source: string;
  path: string;
}

export interface SkillDocument extends SkillIndexEntry {
  body: string;
  resources: string[];
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function parseSkillMarkdown(text: string, source = 'inline'): SkillDocument {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new AppError('skills.INVALID', 'SKILL.md has no frontmatter', undefined, 400);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const pair = /^([a-zA-Z_]+):\s*(.+)$/.exec(line.trim());
    if (pair?.[1] && pair[2]) fields.set(pair[1], pair[2].trim());
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  if (!NAME.test(name)) throw new AppError('skills.INVALID', `invalid skill name "${name}"`);
  if (description.length < 10 || description.length > 400) {
    throw new AppError('skills.INVALID', 'skill description must be 10–400 characters');
  }
  return {
    name,
    description,
    source,
    path: `${name}/SKILL.md`,
    body: (match[2] ?? '').trim(),
    resources: [],
  };
}

export async function loadSkillPack(root: string): Promise<SkillIndexEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const skills: SkillIndexEntry[] = [];
  for (const entry of entries) {
    const path = join(root, entry, 'SKILL.md');
    if (!(await stat(path).catch(() => null))?.isFile()) continue;
    try {
      const parsed = parseSkillMarkdown(await readFile(path, 'utf8'), root);
      skills.push({
        name: parsed.name,
        description: parsed.description,
        source: root,
        path,
      });
    } catch {
      // A malformed skill is skipped; `/config` can show the pack error later.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkill(root: string, name: string): Promise<SkillDocument> {
  if (!NAME.test(name)) throw new AppError('skills.INVALID', `invalid skill name "${name}"`);
  const path = resolve(root, name, 'SKILL.md');
  if (!path.startsWith(`${resolve(root)}/`))
    throw new AppError('skills.INVALID', 'unsafe skill path');
  try {
    const parsed = parseSkillMarkdown(await readFile(path, 'utf8'), root);
    const resources = await readdir(join(root, name)).catch(() => [] as string[]);
    return { ...parsed, resources: resources.filter((entry) => entry !== 'SKILL.md') };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw notFound(`skill ${name} is not installed`);
  }
}

/** The prompt index: names + descriptions only (~30 tokens per skill). */
export function skillIndexForPrompt(skills: SkillIndexEntry[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
}

const SKILL_SECRET =
  /(?:bearer\s+[a-z0-9._-]{8,}|api[_-]?key\s*[:=]|password\s*[:=]|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;

export function slugifySkillName(text: string, fallback = 'chat-preference'): string {
  const value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return NAME.test(value) ? value : fallback;
}

export function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n${body}\n`;
}

export function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

/** Deterministic preference capture; model output is never consulted. */
export function capturePreference(
  text: string,
): { kind: 'explicit' | 'suggestion'; instruction: string } | null {
  const trimmed = text.trim();
  if (trimmed.length < 12 || trimmed.length > 2_000) return null;
  if (SKILL_SECRET.test(trimmed)) return null;
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(trimmed)) return null;
  const explicit =
    /\b(remember (that|this|:)|from now on|going forward|make (this|it) a skill|always|never|don't ever|do not ever)\b/i.test(
      trimmed,
    );
  const inferred =
    /\b(be (more )?(concise|brief|detailed|formal|casual|direct)|prefer|please use|use (a |an )?(bullet|table|json|markdown)|cite|don't use|do not use)\b/i.test(
      trimmed,
    );
  if (!explicit && !inferred) return null;
  const instruction = trimmed
    .replace(
      /^(please\s+)?(remember (that|this|:)|from now on,?|going forward,?|make (this|it) a skill[:,]?)\s*/i,
      '',
    )
    .trim();
  if (instruction.length < 8) return null;
  return { kind: explicit ? 'explicit' : 'suggestion', instruction };
}
