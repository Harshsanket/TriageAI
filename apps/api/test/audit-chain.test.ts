import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import type { Kernel } from '@triageai/kernel';

import { buildApp } from '../src/app.js';
import { writeAudit } from '../src/services/audit.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
type App = FastifyInstance & { kernel?: Kernel };

let app: App;
beforeEach(async () => {
  app = (await buildApp({
    quiet: true,
    configPath: resolve(process.cwd(), '../../triage.config.json'),
  })) as App;
});
afterEach(async () => {
  await app.close();
});

describeIfDb('tamper-evident audit chain (phase 18)', () => {
  it('verifies new rows and detects an edited row', async () => {
    const database = app.kernel!.database;
    await database.query(`DELETE FROM audit_events`);
    await writeAudit(database, { actor: 'a', action: 'test.chain', subject: 'one' });
    await writeAudit(database, { actor: 'b', action: 'test.chain', subject: 'two' });

    const verified = await app.inject({ method: 'GET', url: '/api/v1/system/audit/verify' });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({ ok: true });

    const target = (
      await database.query<{ id: string }>(
        `SELECT id FROM audit_events WHERE action = 'test.chain' ORDER BY created_at DESC LIMIT 1`,
      )
    )[0]!;
    await database.query(`UPDATE audit_events SET subject = 'tampered' WHERE id = $1`, [target.id]);

    const broken = await app.inject({ method: 'GET', url: '/api/v1/system/audit/verify' });
    expect(broken.json()).toMatchObject({
      ok: false,
      brokenAt: target.id,
      reason: 'hash_mismatch',
    });
  });
});
