/** docs-internal importer (Phase 17.T4): reproduce an agent's setup interview,
 * instructions, principles, skill mode and workspace layout from a pinned repo. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface DocsInternalAgent {
  source: string;
  questions: string[];
  instructions: string;
  principles: string;
  skillMode: 'auto' | 'guided' | 'manual' | 'off';
  layout: string[];
  gitProtection: {
    neverStage: string[];
    explicitPathStaging: boolean;
    noPushWithoutApproval: boolean;
  };
}

async function optional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function extractQuestions(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.endsWith('?'))
    .slice(0, 20);
}

export async function importDocsInternal(root: string): Promise<DocsInternalAgent> {
  const agent = await optional(join(root, 'AGENT.md'));
  const instructions = await optional(join(root, 'INSTRUCTIONS.md'));
  const principles = await optional(join(root, 'CODING-PRINCIPLES.md'));
  const combined = `${agent}\n${instructions}`;
  const skillModeMatch = /skill mode[^\n:]*:\s*(auto|guided|manual|off)/i.exec(combined);
  const layout = await readdir(root).catch(() => [] as string[]);
  const neverStage: string[] = [];
  if (/never stage[^\n]*AGENTS\.md/i.test(combined)) neverStage.push('AGENTS.md');
  if (/never stage[^\n]*docs-internal/i.test(combined)) neverStage.push('docs-internal/');
  return {
    source: root,
    questions: extractQuestions(agent),
    instructions: instructions.trim(),
    principles: principles.trim(),
    skillMode: (skillModeMatch?.[1]?.toLowerCase() as DocsInternalAgent['skillMode']) ?? 'guided',
    layout: ['specs/', 'plans/', 'decisions/', 'map/', 'log/', 'handoff.md'].filter((entry) =>
      layout.some((item) => item === entry.replace(/\/$/, '')),
    ),
    gitProtection: {
      neverStage,
      explicitPathStaging: /explicit[- ]path staging/i.test(combined),
      noPushWithoutApproval: /no push without approval/i.test(combined),
    },
  };
}
