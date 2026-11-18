/** Import a Claude Code / Cursor plugin pack as skills + agent profiles
 * (Phase 15.T6). Content only: no harness automations or slash commands run. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

export interface ImportedSkill {
  name: string;
  description: string;
  body: string;
  sourcePath: string;
}

export interface ImportedAgentProfile {
  name: string;
  body: string;
  sourcePath: string;
}

export interface ImportResult {
  pluginId: string;
  skills: ImportedSkill[];
  agents: ImportedAgentProfile[];
  notImported: string[];
}

const PluginJsonSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();

/** Names become directory/route-adjacent identifiers; never accept traversal. */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

function frontmatter(text: string): { name?: string; description?: string; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { body: text.trim() };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const pair = /^([a-zA-Z_]+):\s*(.+)$/.exec(line.trim());
    if (pair?.[1] && pair[2]) fields[pair[1]] = pair[2].trim();
  }
  return { name: fields.name, description: fields.description, body: (match[2] ?? '').trim() };
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeName(value: string): boolean {
  return SAFE_NAME.test(value) && !value.includes('..');
}

function harnessEntries(paths: string[]): string[] {
  const prefixes = ['.cursor-plugin', '.claude-plugin', 'automations', 'commands', 'hooks'];
  return prefixes
    .filter((prefix) => paths.some((path) => path === prefix || path.startsWith(`${prefix}/`)))
    .map((prefix) => `${prefix} (harness-specific)`);
}

export async function importPluginPack(root: string): Promise<ImportResult> {
  const plugin =
    (await readJson(join(root, 'plugin.json'))) ??
    (await readJson(join(root, '.claude-plugin', 'plugin.json'))) ??
    (await readJson(join(root, '.cursor-plugin', 'plugin.json'))) ??
    {};
  const parsed = PluginJsonSchema.parse(plugin);
  const pluginId = parsed.id ?? parsed.name ?? 'imported-plugin';
  const skills: ImportedSkill[] = [];
  const agents: ImportedAgentProfile[] = [];
  const notImported: string[] = [];

  const skillDirs = await readdir(join(root, 'skills')).catch(() => [] as string[]);
  for (const dir of skillDirs) {
    const path = join(root, 'skills', dir, 'SKILL.md');
    if (!(await stat(path).catch(() => null))?.isFile()) continue;
    const parsedSkill = frontmatter(await readFile(path, 'utf8'));
    const name = parsedSkill.name ?? dir;
    if (!safeName(name)) {
      notImported.push(`skills/${dir} (unsafe name)`);
      continue;
    }
    skills.push({
      name,
      description: parsedSkill.description ?? '',
      body: parsedSkill.body,
      sourcePath: path,
    });
  }

  const agentFiles = await readdir(join(root, 'agents')).catch(() => [] as string[]);
  for (const file of agentFiles) {
    if (!file.endsWith('.md')) continue;
    const path = join(root, 'agents', file);
    const parsedAgent = frontmatter(await readFile(path, 'utf8'));
    const name = parsedAgent.name ?? file.replace(/\.md$/, '');
    if (!safeName(name)) {
      notImported.push(`agents/${file} (unsafe name)`);
      continue;
    }
    agents.push({ name, body: parsedAgent.body, sourcePath: path });
  }

  // Harness-specific features are reported, never silently dropped.
  for (const path of ['.cursor-plugin', '.claude-plugin', 'automations', 'commands', 'hooks']) {
    if (await stat(join(root, path)).catch(() => null)) {
      notImported.push(`${path} (harness-specific)`);
    }
  }
  return { pluginId, skills, agents, notImported };
}

/**
 * In-memory variant used by the signed pack installer (22.T12). Archive paths
 * are already traversal-checked by `unpackFiles`; names are checked again here
 * because a frontmatter `name` is attacker-controlled content.
 */
export function importPackContents(
  files: Map<string, Uint8Array | Buffer | string>,
  pluginId = 'imported-pack',
): ImportResult {
  const paths = [...files.keys()];
  const skills: ImportedSkill[] = [];
  const agents: ImportedAgentProfile[] = [];
  const notImported = harnessEntries(paths);

  const text = (path: string): string => {
    const value = files.get(path);
    if (value === undefined) return '';
    return typeof value === 'string' ? value : Buffer.from(value).toString('utf8');
  };

  for (const path of paths) {
    const skillMatch = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
    if (skillMatch?.[1]) {
      const parsedSkill = frontmatter(text(path));
      const name = parsedSkill.name ?? skillMatch[1];
      if (!safeName(name)) {
        notImported.push(`${path} (unsafe name)`);
        continue;
      }
      skills.push({
        name,
        description: parsedSkill.description ?? '',
        body: parsedSkill.body,
        sourcePath: path,
      });
      continue;
    }
    const agentMatch = /^agents\/([^/]+)\.md$/.exec(path);
    if (agentMatch?.[1]) {
      const parsedAgent = frontmatter(text(path));
      const name = parsedAgent.name ?? agentMatch[1];
      if (!safeName(name)) {
        notImported.push(`${path} (unsafe name)`);
        continue;
      }
      agents.push({ name, body: parsedAgent.body, sourcePath: path });
    }
  }

  return {
    pluginId,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
    notImported,
  };
}
