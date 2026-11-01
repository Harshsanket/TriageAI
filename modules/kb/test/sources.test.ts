import { describe, expect, it } from 'vitest';

import { runKnowledgeSourceContract } from '@triageai/kernel';
import type { EgressCapability } from '@triageai/kernel';

import { createGitHubSource, createUrlSource } from '../src/sources.js';

function egress(handler: (url: string) => Response | Promise<Response>): EgressCapability {
  return {
    allows: (url) =>
      url.startsWith('https://api.github.com') || url.startsWith('https://example.com'),
    fetch: async (url) => handler(url),
  };
}

describe('knowledge source contract (phase 20.2)', () => {
  it('url source yields one item and fetches through egress', async () => {
    const source = createUrlSource(
      egress(
        () =>
          new Response('# Page\n\nHello world', {
            status: 200,
            headers: { 'content-type': 'text/markdown' },
          }),
      ),
    );
    await runKnowledgeSourceContract(source, [
      {
        config: { url: 'https://example.com/page' },
        expectedItems: [{ name: 'page', mediaType: 'text/markdown' }],
      },
    ]);
  });

  it('github source pins the resolved commit and fetches md files', async () => {
    const files: Record<string, string> = {
      '/repos/acme/docs': JSON.stringify({ default_branch: 'main' }),
      '/repos/acme/docs/git/trees/main?recursive=1': JSON.stringify({
        tree: [
          { path: 'README.md', type: 'blob', sha: 'sha-readme' },
          { path: 'docs/guide.md', type: 'blob', sha: 'sha-guide' },
          { path: 'logo.png', type: 'blob', sha: 'sha-logo' },
          { path: 'src/app.ts', type: 'blob', sha: 'sha-app' },
        ],
      }),
      '/repos/acme/docs/contents/README.md?ref=sha-readme': JSON.stringify({
        content: Buffer.from('# Readme').toString('base64'),
      }),
      '/repos/acme/docs/contents/docs/guide.md?ref=sha-guide': JSON.stringify({
        content: Buffer.from('# Guide').toString('base64'),
      }),
    };
    const source = createGitHubSource(
      egress((url) => {
        const path = new URL(url).pathname + new URL(url).search;
        const body = files[path];
        return body ? new Response(body) : new Response('missing', { status: 404 });
      }),
    );
    const items: Array<{ externalId: string; name: string }> = [];
    for await (const item of source.list({ repo: 'acme/docs' })) {
      items.push({ externalId: item.externalId, name: item.name });
      expect(new TextDecoder().decode(await item.fetch())).toContain('#');
    }
    expect(items).toEqual([
      { externalId: 'acme/docs@sha-readme:README.md', name: 'README.md' },
      { externalId: 'acme/docs@sha-guide:docs/guide.md', name: 'docs/guide.md' },
    ]);
  });

  it('rejects a config the source does not understand', () => {
    const source = createUrlSource(egress(() => new Response('')));
    expect(source.configSchema.safeParse({}).success).toBe(false);
    expect(source.configSchema.safeParse({ url: 'not-a-url' }).success).toBe(false);
  });
});
