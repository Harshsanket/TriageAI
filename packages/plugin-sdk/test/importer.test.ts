import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { importPluginPack } from '../src/importer.js';

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
});
