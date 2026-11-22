/** docs-internal importer (Phase 17.T4): reproduce an agent's setup interview,
 * instructions, principles, skill mode and workspace layout from a local
 * checkout or a pinned GitHub repository. Scripts are never executed. */
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

export interface DocsInternalFetcher {
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
    options?: { purpose?: string; maxBytes?: number },
  ): Promise<Response>;
}

const FILES = ['AGENT.md', 'INSTRUCTIONS.md', 'CODING-PRINCIPLES.md'] as const;
const LAYOUT = ['specs', 'plans', 'decisions', 'map', 'log'] as const;

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

function parse(args: {
  source: string;
  agent: string;
  instructions: string;
  principles: string;
  entries: string[];
}): DocsInternalAgent {
  const combined = `${args.agent}\n${args.instructions}`;
  const skillModeMatch = /skill mode[^\n:]*:\s*(auto|guided|manual|off)/i.exec(combined);
  const neverStage: string[] = [];
  if (/never stage[^\n]*AGENTS\.md/i.test(combined)) neverStage.push('AGENTS.md');
  if (/never stage[^\n]*docs-internal/i.test(combined)) neverStage.push('docs-internal/');
  return {
    source: args.source,
    questions: extractQuestions(args.agent),
    instructions: args.instructions.trim(),
    principles: args.principles.trim(),
    skillMode: (skillModeMatch?.[1]?.toLowerCase() as DocsInternalAgent['skillMode']) ?? 'guided',
    layout: LAYOUT.map((entry) => `${entry}/`).filter((entry) =>
      args.entries.some((item) => item === entry.replace(/\/$/, '')),
    ),
    gitProtection: {
      neverStage,
      explicitPathStaging: /explicit[- ]path staging/i.test(combined),
      noPushWithoutApproval: /no push without approval/i.test(combined),
    },
  };
}

export async function importDocsInternal(root: string): Promise<DocsInternalAgent> {
  const [agent, instructions, principles, entries] = await Promise.all([
    optional(join(root, 'AGENT.md')),
    optional(join(root, 'INSTRUCTIONS.md')),
    optional(join(root, 'CODING-PRINCIPLES.md')),
    readdir(root).catch(() => [] as string[]),
  ]);
  return parse({ source: root, agent, instructions, principles, entries });
}

/**
 * Resolve `repo` at an explicit ref (branch, tag or 40-char commit), pin the
 * resolved SHA, and fetch the three docs-internal files at that SHA.
 */
export async function importDocsInternalRepo(args: {
  repo: string;
  ref?: string;
  fetcher: DocsInternalFetcher;
}): Promise<DocsInternalAgent & { commit: string }> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) {
    throw new Error('repo must be <owner>/<name>');
  }
  const ref = args.ref?.trim() || 'HEAD';
  const commitResponse = await args.fetcher.fetch(
    `https://api.github.com/repos/${args.repo}/commits/${encodeURIComponent(ref)}`,
    { method: 'GET', headers: { accept: 'application/vnd.github+json' } },
    { purpose: 'docs-internal-import', maxBytes: 200_000 },
  );
  if (!commitResponse.ok) throw new Error(`GitHub answered ${commitResponse.status} for ${ref}`);
  const commit = ((await commitResponse.json()) as { sha?: string }).sha;
  if (!commit || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error('GitHub did not return a commit SHA');

  const files = await Promise.all(
    FILES.map(async (path) => {
      const response = await args.fetcher.fetch(
        `https://raw.githubusercontent.com/${args.repo}/${commit}/${path}`,
        { method: 'GET', headers: { accept: 'text/plain' } },
        { purpose: 'docs-internal-import', maxBytes: 200_000 },
      );
      return response.ok ? await response.text() : '';
    }),
  );
  if (!files[0]) throw new Error('AGENT.md was not found at the pinned commit');
  const listing = await args.fetcher.fetch(
    `https://api.github.com/repos/${args.repo}/contents?ref=${commit}`,
    { method: 'GET', headers: { accept: 'application/vnd.github+json' } },
    { purpose: 'docs-internal-import', maxBytes: 500_000 },
  );
  const entries = listing.ok
    ? ((await listing.json()) as Array<{ name?: string }>)
        .map((entry) => entry.name ?? '')
        .filter(Boolean)
    : [];
  return {
    ...parse({
      source: `${args.repo}@${commit}`,
      agent: files[0],
      instructions: files[1] ?? '',
      principles: files[2] ?? '',
      entries,
    }),
    commit,
  };
}
