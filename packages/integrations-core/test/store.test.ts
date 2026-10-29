import { describe, expect, it } from 'vitest';

import type { Database } from '@triageai/kernel';

import { createActionStore } from '../src/index.js';

const fakeDb = (rows: Record<string, unknown>[]): Database =>
  ({ query: async () => rows }) as unknown as Database;

describe('action store', () => {
  it('refuses table names that are not plain identifiers', () => {
    expect(() => createActionStore(fakeDb([]), 'x', 'actions; DROP TABLE users')).toThrow(
      /invalid action table/,
    );
  });

  it('treats a repeated transition as a no-op', async () => {
    const row = { id: 'a1', ticket_id: 't1', status: 'approved' };
    const store = createActionStore(fakeDb([row]), 'github', 'integration_github_actions');
    await expect(
      store.transition({
        id: 'a1',
        from: ['pending_approval'],
        to: 'approved',
        actor: 'admin',
        auditAction: 'integration.github.approved',
      }),
    ).resolves.toEqual(row);
  });

  it('rejects a transition from an unexpected status', async () => {
    const store = createActionStore(
      fakeDb([{ id: 'a1', ticket_id: 't1', status: 'sent' }]),
      'slack',
      'integration_slack_actions',
    );
    await expect(
      store.transition({
        id: 'a1',
        from: ['failed'],
        to: 'approved',
        actor: 'admin',
        auditAction: 'integration.slack.retried',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
