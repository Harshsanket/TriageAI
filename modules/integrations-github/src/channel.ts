/**
 * GitHub Issues OutputChannel adapter. Delivery semantics (retry, rate limits,
 * token rotation, idempotent dedupe) come from the kernel's shared HTTP shell;
 * only GitHub payload/ref shapes live here.
 */
import {
  HttpOutputChannel,
  TokenRotator,
  type DeliveryContext,
  type OutboundIntent,
  type OutboundMatch,
  type OutboundQuery,
  type OutputChannel,
} from '@triageai/kernel';

export interface GitHubChannelOptions {
  repo: string;
  baseUrl: string;
  channel: string;
  tokens: string[];
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface GitHubIssue {
  number?: number;
  html_url?: string;
  title?: string;
  body?: string;
  id?: number;
}

const headers = (): Record<string, string> => ({
  accept: 'application/vnd.github+json',
  'user-agent': 'triageai-integrations',
  'x-github-api-version': '2022-11-28',
});

function operation(intent: OutboundIntent): string {
  return typeof intent.metadata?.operation === 'string'
    ? (intent.metadata.operation as string)
    : 'create';
}

function issueRef(intent: OutboundIntent, body: GitHubIssue, repo: string): string {
  const number = body.number ?? (intent.metadata?.issueNumber as number | undefined);
  return number ? `${repo}#${number}` : `${repo}#unknown`;
}

function parseIssue(
  responseBody: unknown,
  intent: OutboundIntent,
  repo: string,
): { ref: string; detail: Record<string, unknown> } {
  const issue = (responseBody ?? {}) as GitHubIssue;
  return {
    ref: issueRef(intent, issue, repo),
    detail: {
      number: issue.number ?? intent.metadata?.issueNumber ?? null,
      url: issue.html_url ?? intent.metadata?.issueUrl ?? null,
      operation: operation(intent),
    },
  };
}

export function createGitHubChannel(options: GitHubChannelOptions): OutputChannel {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const auth = new TokenRotator({ tokens: options.tokens });
  return new HttpOutputChannel({
    channel: options.channel,
    enabled: () => options.tokens.length > 0,
    auth,
    fetchImpl: options.fetchImpl,
    request: (_ctx: DeliveryContext, intent: OutboundIntent) => {
      const op = operation(intent);
      if (op === 'close' || op === 'comment') {
        const issueNumber = intent.metadata?.issueNumber;
        if (typeof issueNumber !== 'number') {
          throw new Error(`${op} requires metadata.issueNumber`);
        }
        if (op === 'close') {
          return {
            url: `${baseUrl}/repos/${options.repo}/issues/${issueNumber}`,
            method: 'PATCH',
            headers: headers(),
            body: { state: 'closed' },
          };
        }
        return {
          url: `${baseUrl}/repos/${options.repo}/issues/${issueNumber}/comments`,
          method: 'POST',
          headers: headers(),
          body: { body: intent.body },
        };
      }
      return {
        url: `${baseUrl}/repos/${options.repo}/issues`,
        method: 'POST',
        headers: headers(),
        // Creating an issue is not idempotent: a 5xx may mean GitHub created it
        // and lost the response. The module retries via marker search instead.
        retryServerErrors: false,
        body: {
          title: intent.title ?? intent.body.slice(0, 120),
          body: intent.body,
          ...(intent.labels && intent.labels.length > 0 ? { labels: intent.labels } : {}),
        },
      };
    },
    parse: (response, _ctx, intent) => parseIssue(response.body, intent, options.repo),
    search: async (
      _ctx: DeliveryContext,
      query: OutboundQuery,
      request: typeof import('@triageai/kernel').requestWithRetry,
    ): Promise<OutboundMatch[]> => {
      const terms = [`repo:${options.repo}`, 'is:issue'];
      if (query.metadata?.mode === 'subject') terms.push('in:title');
      terms.push(`"${query.text.replace(/"/g, ' ')}"`);
      const response = await request({
        url: `${baseUrl}/search/issues?q=${encodeURIComponent(terms.join(' '))}&per_page=${query.limit ?? 5}`,
        method: 'GET',
        headers: headers(),
        auth,
        fetchImpl: options.fetchImpl,
      });
      const body = (response.body ?? {}) as { items?: GitHubIssue[] };
      return (body.items ?? []).map((issue) => ({
        ref: `${options.repo}#${issue.number ?? 'unknown'}`,
        title: issue.title,
        url: issue.html_url,
        detail: { number: issue.number ?? null, body: issue.body ?? null },
      }));
    },
  });
}
