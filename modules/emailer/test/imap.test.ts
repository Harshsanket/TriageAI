import { describe, expect, it } from 'vitest';

import { createImapPoller, type ImapInbound } from '../src/imap.js';

const logger = { warn: () => undefined };

describe('IMAP poller (13.T2)', () => {
  it('delivers pulled messages and dedupes overlapping polls', async () => {
    const delivered: ImapInbound[] = [];
    let resolvePull: (() => void) | undefined;
    let pulls = 0;
    const poller = createImapPoller({
      pull: async () => {
        pulls += 1;
        await new Promise<void>((resolve) => {
          resolvePull = resolve;
        });
        return [
          {
            messageId: `msg-${pulls}@test`,
            from: 'customer@test.dev',
            subject: 'hello',
            text: 'body',
          },
        ];
      },
      onMessage: async (message) => {
        delivered.push(message);
      },
      intervalMs: 60_000,
      logger,
    });
    const first = poller.pollOnce();
    const second = poller.pollOnce(); // overlap is skipped
    resolvePull?.();
    await first;
    await second;
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.messageId).toBe('msg-1@test');
    poller.stop();
  });
});
