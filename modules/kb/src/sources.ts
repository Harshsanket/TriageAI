/**
 * Built-in KnowledgeSource implementations (Phase 20.4, ADR-0051): URL pages
 * and GitHub repositories. Both fetch through the single egress client; the
 * KB pipeline owns dedupe, extraction, chunking and indexing.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { EgressCapability, KnowledgeSource, KnowledgeSourceItem } from '@triageai/kernel';
import { AppError } from '@triageai/kernel';
import { mediaTypeFor } from '@triageai/rag';

const MAX_BYTES = 5_000_000;
const MAX_GITHUB_FILES = 100;

const DOC_EXTENSIONS = /\.(md|mdx|txt|html?|json|ya?ml|csv|pdf)$/i;

interface Fetched {
  bytes: Uint8Array;
  mediaType: string;
  finalUrl?: string;
}

async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.ok) {
    throw new AppError(
      'kb.SOURCE_FETCH_FAILED',
      `source fetch answered ${res.status}`,
      undefined,
      502,
    );
  }
  const length = Number(res.headers.get('content-length') ?? '0');
  if (length > MAX_BYTES) {
    throw new AppError(
      'kb.SOURCE_TOO_LARGE',
      `source is larger than ${MAX_BYTES} bytes`,
      undefined,
      413,
    );
  }
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new AppError(
      'kb.SOURCE_TOO_LARGE',
      `source is larger than ${MAX_BYTES} bytes`,
      undefined,
      413,
    );
  }
  return buffer;
}

export function createUrlSource(
  egress: EgressCapability | undefined,
  actor?: string,
): KnowledgeSource {
  return {
    type: 'url',
    label: 'Website',
    configSchema: z.object({ url: z.string().url(), title: z.string().optional() }).strict(),
    async *list(config): AsyncIterable<KnowledgeSourceItem> {
      if (!egress)
        throw new AppError('kb.EGRESS_OFF', 'egress client is not configured', undefined, 503);
      const { url } = config as { url: string; title?: string };
      const fetched = await fetchUrl(egress, url, actor);
      const name = url.split('/').filter(Boolean).pop() || new URL(url).hostname;
      yield {
        externalId: url,
        name,
        mediaType: fetched.mediaType,
        contentHash: hashBytes(fetched.bytes),
        size: fetched.bytes.byteLength,
        fetch: async () => fetched.bytes,
      };
    },
  };
}

export function createGitHubSource(
  egress: EgressCapability | undefined,
  actor?: string,
): KnowledgeSource {
  return {
    type: 'github',
    label: 'GitHub',
    configSchema: z
      .object({
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        ref: z.string().max(200).optional(),
        path: z.string().max(300).optional(),
        token: z.string().max(500).optional(),
      })
      .strict(),
    async *list(config): AsyncIterable<KnowledgeSourceItem> {
      if (!egress)
        throw new AppError('kb.EGRESS_OFF', 'egress client is not configured', undefined, 503);
      const cfg = config as { repo: string; ref?: string; path?: string; token?: string };
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'user-agent': 'triageai-kb',
      };
      if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
      const repoRes = await egress.fetch(
        `https://api.github.com/repos/${cfg.repo}`,
        { headers },
        { actor: actor ?? null, purpose: 'kb.github.repo' },
      );
      if (!repoRes.ok) throw githubError(repoRes);
      const repo = (await repoRes.json()) as { default_branch?: string };
      const ref = cfg.ref ?? repo.default_branch ?? 'HEAD';
      const treeRes = await egress.fetch(
        `https://api.github.com/repos/${cfg.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
        { headers },
        { actor: actor ?? null, purpose: 'kb.github.tree' },
      );
      if (!treeRes.ok) throw githubError(treeRes);
      const tree = (await treeRes.json()) as {
        tree?: Array<{ path: string; type: string; sha: string; size?: number }>;
      };
      const prefix = cfg.path?.replace(/^\/+|\/+$/g, '');
      const files = (tree.tree ?? [])
        .filter((entry) => entry.type === 'blob' && DOC_EXTENSIONS.test(entry.path))
        .filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
        .filter((entry) => !entry.path.includes('node_modules/'))
        .slice(0, MAX_GITHUB_FILES);
      for (const file of files) {
        yield {
          externalId: `${cfg.repo}@${file.sha}:${file.path}`,
          name: file.path,
          mediaType: mediaTypeFor(file.path, 'text/plain'),
          contentHash: file.sha,
          ...(file.size !== undefined ? { size: file.size } : {}),
          fetch: async () => {
            const contentRes = await egress.fetch(
              `https://api.github.com/repos/${cfg.repo}/contents/${file.path}?ref=${file.sha}`,
              { headers },
              { actor: actor ?? null, purpose: 'kb.github.file' },
            );
            if (!contentRes.ok) throw githubError(contentRes);
            const content = (await contentRes.json()) as { content?: string; encoding?: string };
            if (!content.content) {
              throw new AppError(
                'kb.SOURCE_FETCH_FAILED',
                `${file.path} has no content`,
                undefined,
                502,
              );
            }
            return new Uint8Array(Buffer.from(content.content.replace(/\n/g, ''), 'base64'));
          },
        };
      }
    },
  };
}

async function fetchUrl(egress: EgressCapability, url: string, actor?: string): Promise<Fetched> {
  const res = await egress.fetch(url, {}, { actor: actor ?? null, purpose: 'kb.url' });
  const bytes = await readCapped(res);
  const type =
    res.headers.get('content-type')?.split(';')[0] ?? mediaTypeFor(new URL(url).pathname);
  return { bytes, mediaType: type, finalUrl: res.url || url };
}

function githubError(res: Response): AppError {
  return new AppError(
    'kb.SOURCE_FETCH_FAILED',
    `GitHub answered ${res.status}; check the repo, ref and token`,
    undefined,
    502,
  );
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
