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
    skills.push({
      name: parsedSkill.name ?? dir,
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
    agents.push({
      name: parsedAgent.name ?? file.replace(/\.md$/, ''),
      body: parsedAgent.body,
      sourcePath: path,
    });
  }

  // Harness-specific features are reported, never silently dropped.
  for (const path of ['.cursor-plugin', '.claude-plugin', 'automations', 'commands', 'hooks']) {
    if (await stat(join(root, path)).catch(() => null)) {
      notImported.push(`${path} (harness-specific)`);
    }
  }
  return { pluginId, skills, agents, notImported };
}
