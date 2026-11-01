import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadSkillPack,
  parseSkillMarkdown,
  readSkill,
  skillIndexForPrompt,
} from '../src/skills/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('skills (phase 15)', () => {
  it('parses frontmatter and keeps the body lazy', () => {
    const skill = parseSkillMarkdown(
      '---\nname: handoff\ndescription: Write a concise structured handoff for another agent.\n---\n\n# Handoff\n\nDo the thing.',
    );
    expect(skill).toMatchObject({ name: 'handoff' });
    expect(skill.body).toContain('Do the thing');
  });

  it('rejects malformed or unsafe skills', () => {
    expect(() => parseSkillMarkdown('no frontmatter')).toThrow();
    expect(() =>
      parseSkillMarkdown('---\nname: ../evil\ndescription: x'.padEnd(80, 'x') + '\n---\n'),
    ).toThrow();
  });

  it('loads a pack index and reads a body on demand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'triageai-skills-'));
    roots.push(root);
    await mkdir(join(root, 'handoff'));
    await writeFile(
      join(root, 'handoff', 'SKILL.md'),
      '---\nname: handoff\ndescription: Write a concise structured handoff for another agent.\n---\n\nBody text.',
    );
    await writeFile(join(root, 'handoff', 'template.md'), 'resource');
    const index = await loadSkillPack(root);
    expect(index).toHaveLength(1);
    expect(skillIndexForPrompt(index)).toContain('handoff:');
    const skill = await readSkill(root, 'handoff');
    expect(skill.body).toBe('Body text.');
    expect(skill.resources).toContain('template.md');
    await expect(readSkill(root, 'missing')).rejects.toThrow(/not installed/);
  });
});
