import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import type { Capabilities, ClassificationResult } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const SUPPORT_CONFIG = resolve(process.cwd(), '../../config/presets/support.json');

// `buildApp` used to write the host's model registry into the caller's
// capabilities object. Reusing that object across boots left the second app
// pointing at the first app's closed database; classify then hung until the
// close timeout. Keep the regression pinned without relying on test timing.
const shared: Capabilities = {
  classifier: {
    classify: async (): Promise<ClassificationResult> => ({
      category: 'billing',
      confidence: 0.9,
      margin: 0.3,
      method: 'zero-shot',
      modelVersion: 'fake',
      scores: [{ category: 'billing', score: 0.9 }],
    }),
  },
};

describeIfDb('capability injection isolation', () => {
  let apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const app of apps.reverse()) await app.close();
    apps = [];
  });

  it('does not mutate a caller-provided capabilities object', async () => {
    const first = await buildApp({ quiet: true, configPath: SUPPORT_CONFIG, capabilities: shared });
    apps.push(first);
    expect(shared.modelRegistry).toBeUndefined();
    await first.close();
    apps = apps.filter((app) => app !== first);

    const second = await buildApp({
      quiet: true,
      configPath: SUPPORT_CONFIG,
      capabilities: shared,
    });
    apps.push(second);
    const res = await second.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: 'Double charge', body: 'I was charged twice this month' },
    });
    expect(res.statusCode).toBe(200);
    const ticketId = (res.json() as { ticketId: string }).ticketId;
    const started = Date.now();
    for (;;) {
      const detail = await second.inject({
        method: 'GET',
        url: `/api/v1/support/tickets/${ticketId}`,
      });
      const status = (detail.json() as { ticket: { status: string } }).ticket.status;
      if (status === 'ROUTED' || status === 'HUMAN_REVIEW') break;
      if (Date.now() - started > 10_000) {
        throw new Error(`ticket stuck in ${status} after a second boot`);
      }
      await new Promise((resolveStatus) => setTimeout(resolveStatus, 100));
    }
  });
});
