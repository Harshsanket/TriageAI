import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, ClassificationResult, Kernel } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const SUPPORT_CONFIG = path.resolve(process.cwd(), '../../triage.config.support.json');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

type App = FastifyInstance & { kernel?: Kernel };

interface TicketPayload {
  ticket: {
    id: string;
    status: string;
    category: string | null;
    priorityCode: string | null;
    teamId: string | null;
    triage: { ambiguous?: boolean; reasons?: string[] } | null;
  };
}

type TicketDto = TicketPayload['ticket'];

function classification(category = 'billing'): ClassificationResult {
  return {
    category,
    confidence: 0.93,
    margin: 0.4,
    method: 'zero-shot',
    modelVersion: 'fake-classifier',
    scores: [{ category, score: 0.93 }],
  };
}

async function clean(database: PostgresDatabase): Promise<void> {
  await database.query(`DELETE FROM eval_reports`);
  await database.query(`DELETE FROM model_assets`);
  await database.query(`DELETE FROM datasets`);
  await database.query(`DELETE FROM candidate_examples`);
  await database.query(`DELETE FROM audit_events`);
  await database.query(`DELETE FROM support_auto_replies`);
  await database.query(`DELETE FROM support_ticket_messages`);
  await database.query(`DELETE FROM support_ticket_events`);
  await database.query(`DELETE FROM support_tickets`);
  await database.query(
    `DELETE FROM workflow_runs WHERE workflow_id IN ('support.triage','support.auto_reply')`,
  );
}

describeIfDb('advanced triage + agent overrides (phase 7)', () => {
  let app: App;
  let database: PostgresDatabase;
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'triageai-phase7-'));
    const raw = JSON.parse(await readFile(SUPPORT_CONFIG, 'utf8')) as {
      modules: Record<string, { enabled: boolean; options?: Record<string, unknown> }>;
    };
    raw.modules.support = {
      enabled: true,
      options: { triage: { fallbackPriorityCode: null } },
    };
    configPath = path.join(tmpDir, 'triage.config.test.json');
    await writeFile(configPath, JSON.stringify(raw));

    database = new PostgresDatabase(DATABASE_URL);
    await clean(database);
    const capabilities: Capabilities = {
      classifier: { classify: async () => classification() },
    };
    app = (await buildApp({ quiet: true, configPath, capabilities })) as App;
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function getTicket(id: string): Promise<TicketPayload> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/support/tickets/${id}` });
    return res.json() as TicketPayload;
  }

  async function waitForStatus(
    id: string,
    statuses: string[],
    timeoutMs = 15000,
  ): Promise<TicketPayload> {
    const started = Date.now();
    for (;;) {
      const body = await getTicket(id);
      if (statuses.includes(body.ticket.status)) return body;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`timeout waiting for ${statuses.join('|')} (last=${body.ticket.status})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function createTicket(subject: string, body: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject, body },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { ticketId: string }).ticketId;
  }

  it('derives deterministic priority + team and routes the ticket', async () => {
    const ticketId = await createTicket('Double charge', 'I was charged twice this month');
    const detail = await waitForStatus(ticketId, ['ROUTED', 'HUMAN_REVIEW']);
    expect(detail.ticket.status).toBe('ROUTED');
    expect(detail.ticket.priorityCode).toBe('P1');
    expect(detail.ticket.teamId).toBe('billing');
    expect(detail.ticket.triage?.ambiguous).toBe(false);

    const policy = await app.inject({ method: 'GET', url: '/api/v1/support/triage-policy' });
    expect(policy.statusCode).toBe(200);
    expect((policy.json() as { priorities: string[] }).priorities).toEqual([
      'P0',
      'P1',
      'P2',
      'P3',
    ]);
  });

  it('sends ambiguous priority/team cases to manual triage (never fabricates ids)', async () => {
    const ticketId = await createTicket('Problem report', 'asdf qwer zxcv');
    const detail = await waitForStatus(ticketId, ['HUMAN_REVIEW']);
    expect(detail.ticket.status).toBe('HUMAN_REVIEW');
    expect(detail.ticket.priorityCode).toBeNull();
    expect(detail.ticket.triage?.ambiguous).toBe(true);
    expect(detail.ticket.triage?.reasons).toContain('priority_signal_missing');
  });

  it('records agent overrides as candidates and feeds the next dataset version', async () => {
    const ticketId = await createTicket('Double charge', 'I was charged twice this month');
    await waitForStatus(ticketId, ['ROUTED', 'HUMAN_REVIEW']);

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/v1/support/tickets/${ticketId}/triage`,
      payload: { priorityCode: 'P2', teamId: 'invented-team' },
    });
    expect(invalid.statusCode).toBe(400);

    const override = await app.inject({
      method: 'PATCH',
      url: `/api/v1/support/tickets/${ticketId}/triage`,
      payload: {
        priorityCode: 'P2',
        teamId: 'engineering',
        actor: 'agent-7',
        method: 'better_answer',
        note: 'This is a product bug, not a billing issue',
      },
    });
    expect(override.statusCode).toBe(200);
    const updated = override.json() as TicketDto;
    expect(updated.priorityCode).toBe('P2');
    expect(updated.teamId).toBe('engineering');

    const proposed = await app.inject({
      method: 'GET',
      url: '/api/v1/system/candidates?status=proposed&source=agent_override',
    });
    const candidates = proposed.json() as Array<{ id: string; gold: Record<string, unknown> }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.gold).toMatchObject({
      category: 'billing',
      priorityCode: 'P2',
      teamId: 'engineering',
    });

    const approved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/system/candidates/${candidates[0]?.id}`,
      payload: { status: 'approved', actor: 'reviewer', method: 'mistake' },
    });
    expect(approved.statusCode).toBe(200);

    const exported = await app.inject({
      method: 'GET',
      url: '/api/v1/system/candidates/export?category=billing',
    });
    expect(exported.statusCode).toBe(200);
    const exportBody = exported.json() as { count: number; examples: Array<{ expected: string }> };
    expect(exportBody.count).toBe(1);
    expect(exportBody.examples[0]?.expected).toBe('billing');

    const dataset = await app.inject({
      method: 'POST',
      url: '/api/v1/datasets',
      payload: { purpose: 'classifier', createdBy: 'reviewer' },
    });
    expect(dataset.statusCode).toBe(201);
    const dto = dataset.json() as { version: string; counts: { train: number } };
    expect(dto.version).toBe('v1');
    expect(dto.counts.train).toBe(1);
  });

  it('clears the ambiguity flag after a valid agent override', async () => {
    const ticketId = await createTicket('Problem report', 'asdf qwer zxcv');
    await waitForStatus(ticketId, ['HUMAN_REVIEW']);

    const override = await app.inject({
      method: 'PATCH',
      url: `/api/v1/support/tickets/${ticketId}/triage`,
      payload: { priorityCode: 'P3', teamId: 'support', actor: 'agent-7' },
    });
    expect(override.statusCode).toBe(200);
    const body = override.json() as TicketDto;
    expect(body.status).toBe('HUMAN_REVIEW');
    expect(body.priorityCode).toBe('P3');
    expect(body.teamId).toBe('support');
    expect(body.triage?.ambiguous).toBe(false);
    expect(body.triage?.reasons).toContain('agent_override');
  });
});
