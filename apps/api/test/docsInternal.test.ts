import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { importDocsInternal, importDocsInternalRepo } from '../src/setup/docsInternal.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function repoFetcher(): {
  calls: string[];
  fetch: (url: string) => Promise<Response>;
} {
  const sha = 'a'.repeat(40);
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      if (url.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha }), { status: 200 });
      }
      if (url.includes(`/${sha}/AGENT.md`)) {
        return new Response(
          '# Setup\n\n- What is the goal?\n\nSkill mode: guided\nNever stage AGENTS.md. Explicit-path staging.',
          { status: 200 },
        );
      }
      if (url.includes(`/${sha}/INSTRUCTIONS.md`))
        return new Response('Be concise.', { status: 200 });
      if (url.includes(`/${sha}/CODING-PRINCIPLES.md`)) {
        return new Response('Prefer simple designs.', { status: 200 });
      }
      if (url.includes('/contents?ref=')) {
        return new Response(JSON.stringify([{ name: 'specs' }, { name: 'log' }]), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    },
  };
}

describe('docs-internal importer (phase 17)', () => {
  it('pins a GitHub repo to a commit and reproduces its setup', async () => {
    const fetcher = repoFetcher();
    const imported = await importDocsInternalRepo({
      repo: 'Harshsanket/docs-internal',
      ref: 'main',
      fetcher,
    });
    expect(imported.commit).toBe('a'.repeat(40));
    expect(imported.questions).toEqual(['What is the goal?']);
    expect(imported.instructions).toBe('Be concise.');
    expect(imported.layout).toEqual(['specs/', 'log/']);
    expect(imported.gitProtection.neverStage).toContain('AGENTS.md');
    expect(imported.gitProtection.explicitPathStaging).toBe(true);
    expect(fetcher.calls.some((url) => url.includes(`/${'a'.repeat(40)}/`))).toBe(true);
  });
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
