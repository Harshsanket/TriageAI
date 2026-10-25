import { describe } from 'vitest';

import { outputChannelContractSuite } from '@triageai/kernel/output-channel-tests';

import { createSlackChannel } from '../src/channel.js';

describe('Slack webhook OutputChannel adapter', () => {
  outputChannelContractSuite(
    'slack-message',
    async (baseUrl) => ({
      channel: createSlackChannel({ webhookUrl: baseUrl, channel: 'slack-message' }),
    }),
    {
      channel: 'slack-message',
      successBody: { ok: true },
    },
  );
});
