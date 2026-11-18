import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORE_MIGRATIONS, MigrationRunner, PostgresDatabase } from '@triageai/kernel';
import type { Kernel } from '@triageai/kernel';

import {
  discoverSkillPaths,
  importSkillFromGithub,
  parseSkillSourceUrl,
  type SkillSourceFetcher,
} from '../src/services/skills.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';
const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const SHA_ONE = 'a'.repeat(40);
const SHA_TWO = 'b'.repeat(40);

interface Route {
  status?: number;
  body: string;
}

function fakeFetcher(routes: Record<string, Route>): SkillSourceFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (url: string) => {
      calls.push(url);
      const route = routes[url];
      if (!route) return new Response('not found', { status: 404 });
      return new Response(route.body, { status: route.status ?? 200 });
    }) as SkillSourceFetcher['fetch'],
  };
}

function skillMarkdown(name: string, body = 'Do the thing.'): string {
  return `---\nname: ${name}\ndescription: A pinned skill imported from GitHub for tests.\n---\n\n${body}`;
}

describeIfDb('git-pinned skill sources (15.T5)', () => {
  let database: PostgresDatabase;
  let kernel: Kernel;
  const names: string[] = [];

  beforeAll(async () => {
    database = new PostgresDatabase(DATABASE_URL);
    await new MigrationRunner(database, noopLogger).apply('kernel', CORE_MIGRATIONS);
    kernel = {
      database,
      modules: [],
      config: { egress: { allowlist: [] } },
    } as unknown as Kernel;
  });

  afterAll(async () => {
    if (names.length > 0) {
      await database
        .query(`DELETE FROM user_skills WHERE name = ANY($1::text[])`, [names])
        .catch(() => undefined);
    }
    await database?.close();
  });

  it('discovers SKILL.md files from a repository tree (27.T8)', async () => {
    const fetcher = fakeFetcher({
      'https://api.github.com/repos/owner/repo/git/trees/main?recursive=1': {
        body: JSON.stringify({
          tree: [
            { path: 'skills/a/SKILL.md', type: 'blob' },
            { path: 'skills/b/SKILL.md', type: 'blob' },
            { path: 'README.md', type: 'blob' },
          ],
        }),
      },
    });
    const paths = await discoverSkillPaths('owner/repo', fetcher);
    expect(paths).toEqual(['skills/a/SKILL.md', 'skills/b/SKILL.md']);
  });

  it('resolves a branch to a commit SHA and reads the SKILL.md at that SHA', async () => {
    const fetcher = fakeFetcher({
      'https://api.github.com/repos/owner/repo/commits/main': {
        body: JSON.stringify({ sha: SHA_ONE }),
      },
      [`https://raw.githubusercontent.com/owner/repo/${SHA_ONE}/SKILL.md`]: {
        body: skillMarkdown('pinned-branch'),
      },
    });
    names.push('pinned-branch');
    const skill = await importSkillFromGithub(
      kernel,
      null,
      { url: 'https://github.com/owner/repo/blob/main/SKILL.md', update: false },
      'tester',
      fetcher,
    );
    expect(skill).toMatchObject({
      name: 'pinned-branch',
      provenance: 'github',
      sourceRef: SHA_ONE,
      enabled: false,
    });
    expect(fetcher.calls[0]).toBe('https://api.github.com/repos/owner/repo/commits/main');
    expect(fetcher.calls).toContain(
      `https://raw.githubusercontent.com/owner/repo/${SHA_ONE}/SKILL.md`,
    );
    expect(fetcher.calls.some((url) => url.includes('/main/SKILL.md'))).toBe(false);
  });

  it('accepts a full blob/<sha>/ URL as already pinned without an API call', async () => {
    const fetcher = fakeFetcher({
      [`https://raw.githubusercontent.com/owner/repo/${SHA_ONE}/skills/pinned/SKILL.md`]: {
        body: skillMarkdown('pinned-direct'),
      },
    });
    names.push('pinned-direct');
    const skill = await importSkillFromGithub(
      kernel,
      null,
      {
        url: `https://github.com/owner/repo/blob/${SHA_ONE}/skills/pinned/SKILL.md`,
        update: false,
      },
      'tester',
      fetcher,
    );
    expect(skill.sourceRef).toBe(SHA_ONE);
    expect(fetcher.calls.some((url) => url.startsWith('https://api.github.com'))).toBe(false);
  });

  it('refuses a moved branch until the pin is updated explicitly', async () => {
    const url = 'https://github.com/owner/moved/blob/main/SKILL.md';
    const first = fakeFetcher({
      'https://api.github.com/repos/owner/moved/commits/main': {
        body: JSON.stringify({ sha: SHA_ONE }),
      },
      [`https://raw.githubusercontent.com/owner/moved/${SHA_ONE}/SKILL.md`]: {
        body: skillMarkdown('moved-skill'),
      },
    });
    names.push('moved-skill');
    const initial = await importSkillFromGithub(
      kernel,
      null,
      { url, update: false },
      'tester',
      first,
    );
    expect(initial.sourceRef).toBe(SHA_ONE);

    const second = fakeFetcher({
      'https://api.github.com/repos/owner/moved/commits/main': {
        body: JSON.stringify({ sha: SHA_TWO }),
      },
      [`https://raw.githubusercontent.com/owner/moved/${SHA_TWO}/SKILL.md`]: {
        body: skillMarkdown('moved-skill', 'New body.'),
      },
    });
    await expect(
      importSkillFromGithub(kernel, null, { url, update: false }, 'tester', second),
    ).rejects.toMatchObject({ code: 'skills.SOURCE_MOVED' });

    const updated = await importSkillFromGithub(
      kernel,
      null,
      { url, update: true },
      'tester',
      second,
    );
    expect(updated).toMatchObject({ sourceRef: SHA_TWO, version: 2 });
  });

  it('rejects traversal and non-Markdown skill paths', () => {
    expect(() =>
      parseSkillSourceUrl('https://github.com/owner/repo/blob/main/..%2F..%2Fetc%2Fpasswd'),
    ).toThrow(/unsafe|traversal/i);
    expect(() => parseSkillSourceUrl('https://github.com/owner/repo/blob/main/README.txt')).toThrow(
      /Markdown/i,
    );
    expect(() => parseSkillSourceUrl('https://gitlab.com/owner/repo/blob/main/SKILL.md')).toThrow(
      /github/i,
    );
  });
});
