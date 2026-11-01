import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { importDocsInternal } from '../src/setup/docsInternal.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('docs-internal importer (phase 17)', () => {
  it('reproduces setup questions, skill mode, layout and git protections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triageai-docs-internal-'));
    roots.push(root);
    await mkdir(join(root, 'specs'));
    await mkdir(join(root, 'log'));
    await writeFile(
      join(root, 'AGENT.md'),
      '# Setup\n\n- What is the goal?\n- Who is the user?\n\nSkill mode: guided\nNever stage AGENTS.md. Explicit-path staging. No push without approval.',
    );
    await writeFile(join(root, 'INSTRUCTIONS.md'), 'Be concise.');
    await writeFile(join(root, 'CODING-PRINCIPLES.md'), 'Prefer simple designs.');

    const imported = await importDocsInternal(root);
    expect(imported.questions).toEqual(['What is the goal?', 'Who is the user?']);
    expect(imported.skillMode).toBe('guided');
    expect(imported.instructions).toBe('Be concise.');
    expect(imported.principles).toBe('Prefer simple designs.');
    expect(imported.layout).toEqual(expect.arrayContaining(['specs/', 'log/']));
    expect(imported.gitProtection).toMatchObject({
      neverStage: ['AGENTS.md'],
      explicitPathStaging: true,
      noPushWithoutApproval: true,
    });
  });
});
