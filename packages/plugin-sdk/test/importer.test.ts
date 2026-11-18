import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { importPackContents, importPluginPack } from '../src/importer.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('plugin-pack importer (phase 15)', () => {
  it('maps skills and agents and reports harness-specific parts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triageai-pack-'));
    roots.push(root);
    await writeFile(join(root, 'plugin.json'), JSON.stringify({ name: 'pstack' }));
    await mkdir(join(root, 'skills', 'handoff'), { recursive: true });
    await writeFile(
      join(root, 'skills', 'handoff', 'SKILL.md'),
      '---\nname: handoff\ndescription: Write a concise structured handoff.\n---\n\nBody.',
    );
    await mkdir(join(root, 'agents'), { recursive: true });
    await writeFile(
      join(root, 'agents', 'reviewer.md'),
      '---\nname: reviewer\n---\n\nReview carefully.',
    );
    await mkdir(join(root, '.cursor-plugin'));
    await writeFile(
      join(root, '.cursor-plugin', 'plugin.json'),
      JSON.stringify({ name: 'pstack' }),
    );

    const result = await importPluginPack(root);
    expect(result.pluginId).toBe('pstack');
    expect(result.skills[0]).toMatchObject({ name: 'handoff', body: 'Body.' });
    expect(result.agents[0]).toMatchObject({ name: 'reviewer' });
    expect(result.notImported.join(' ')).toContain('.cursor-plugin');
  });

  it('imports an in-memory signed pack and rejects unsafe names', () => {
    const files = new Map<string, Uint8Array>([
      [
        'skills/handoff/SKILL.md',
        Buffer.from('---\nname: handoff\ndescription: Write a concise handoff.\n---\n\nBody.'),
      ],
      [
        'skills/bad/SKILL.md',
        Buffer.from('---\nname: ../escape\ndescription: Should never import.\n---\n\nBody.'),
      ],
      ['agents/reviewer.md', Buffer.from('---\nname: reviewer\n---\n\nReview carefully.')],
      ['agents/evil.md', Buffer.from('---\nname: ../../evil\n---\n\nNo.')],
      ['commands/run.md', Buffer.from('harness command')],
    ]);
    const result = importPackContents(files, 'signed-pack');
    expect(result.pluginId).toBe('signed-pack');
    expect(result.skills.map((skill) => skill.name)).toEqual(['handoff']);
    expect(result.agents.map((agent) => agent.name)).toEqual(['reviewer']);
    expect(result.notImported.join(' ')).toContain('commands (harness-specific)');
    expect(result.notImported.join(' ')).toContain('unsafe name');
  });
});
