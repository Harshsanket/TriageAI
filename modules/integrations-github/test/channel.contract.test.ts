import { describe } from 'vitest';

import { outputChannelContractSuite } from '@triageai/kernel/output-channel-tests';

import { createGitHubChannel } from '../src/channel.js';

describe('GitHub Issues OutputChannel adapter', () => {
  outputChannelContractSuite(
    'github-issue',
    async (baseUrl, { tokens }) => ({
      channel: createGitHubChannel({
        repo: 'acme/app',
        baseUrl,
        channel: 'github-issue',
        tokens,
        requestTimeoutMs: 1_000,
      }),
    }),
    {
      channel: 'github-issue',
      supportsTokenRotation: true,
      successBody: { id: 42, number: 7, html_url: 'https://github.test/acme/app/issues/7' },
    },
  );
});
