import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';

import type { Capabilities, ClassificationResult } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const SUPPORT_CONFIG = resolve(process.cwd(), '../../config/presets/support.json');

function result(overrides: Partial<ClassificationResult>): ClassificationResult {
  return {
    category: 'billing',
    confidence: 0.91,
    margin: 0.35,
    method: 'zero-shot',
    modelVersion: 'fake-mini',
    scores: [
      { category: 'billing', score: 0.91 },
      { category: 'security', score: 0.56 },
    ],
    ...overrides,
  };
}

const fakeCapabilities: Capabilities = {
  embedder: {
    embed: async (texts) => ({ vectors: texts.map(() => [1, 0]), modelVersion: 'fake-mini' }),
  },
  classifier: {
    classify: async (text) => {
      if (text.includes('gibberish')) {
        return result({ category: 'unknown', confidence: 0.21, margin: 0.01, scores: [] });
      }
      if (text.includes('hacked')) {
        return result({ category: 'security', confidence: 0.93, margin: 0.4 });
      }
      return result({});
    },
  },
};

async function getTicket(app: FastifyInstance, id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/support/tickets/${id}` });
  return res.json() as {
    ticket: {
      id: string;
      status: string;
      category: string | null;
      team: string | null;
      priority: string | null;
    };
    messages: unknown[];
    events: unknown[];
  };
}

async function waitForStatus(
  app: FastifyInstance,
  id: string,
  statuses: string[],
  timeoutMs = 15000,
) {
  const started = Date.now();
  for (;;) {
    const body = await getTicket(app, id);
    if (statuses.includes(body.ticket.status)) return body;
    if (Date.now() - started > timeoutMs)
      throw new Error(`timeout waiting for ${statuses.join('|')} (last=${body.ticket.status})`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 100));
  }
}

describeIfDb('support vertical slice (phase 3, no LLM)', () => {
  let app: FastifyInstance & { kernel?: import('@triageai/kernel').Kernel };

  beforeEach(async () => {
    app = (await buildApp({
      quiet: true,
      configPath: SUPPORT_CONFIG,
      capabilities: fakeCapabilities,
    })) as FastifyInstance & {
      kernel?: import('@triageai/kernel').Kernel;
    };
  });

  afterEach(async () => {
    await app.close();
  });

  it('classifies, routes, and resolves a billing ticket with full decision trail', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: 'Double charge', body: 'I was charged twice for my subscription' },
    });
    expect(created.statusCode).toBe(200);
    const { ticketId, runId } = created.json() as { ticketId: string; runId: string };

    const detail = await waitForStatus(app, ticketId, ['ROUTED', 'HUMAN_REVIEW']);
    expect(detail.ticket.status).toBe('ROUTED');
    expect(detail.ticket.category).toBe('billing');
    expect(detail.ticket.team).toBe('billing');
    expect(detail.ticket.priority).toBe('high');
    expect(detail.messages.length).toBeGreaterThanOrEqual(2);

    const run = await app.inject({ method: 'GET', url: `/api/v1/system/runs/${runId}` });
    const runBody = run.json() as {
      run: { status: string };
      stages: Array<{ stageId: string; status: string }>;
      decisions: Array<{ deterministic: unknown }>;
    };
    expect(runBody.run.status).toBe('SUCCEEDED');
    expect(runBody.stages.map((stage) => [stage.stageId, stage.status])).toEqual([
      ['load', 'SUCCEEDED'],
      ['classify', 'SUCCEEDED'],
      ['route', 'SUCCEEDED'],
      ['priority', 'SUCCEEDED'],
      ['team', 'SUCCEEDED'],
      ['apply', 'SUCCEEDED'],
      ['dispatch', 'SUCCEEDED'],
    ]);
    expect(runBody.decisions).toHaveLength(7);
    // threshold values + rule ids are in decision records (ADR-0005)
    expect(JSON.stringify(runBody.decisions)).toContain('thresholds');
  });

  it('escalates gibberish to human review with reason codes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: '???', body: 'gibberish asdf qwer zxcv' },
    });
    const { ticketId } = created.json() as { ticketId: string };
    const detail = await waitForStatus(app, ticketId, ['HUMAN_REVIEW']);
    expect(detail.ticket.status).toBe('HUMAN_REVIEW');
    expect(detail.ticket.category).toBe('unknown');
    expect(detail.ticket.team).toBe('human-review');

    const classification = (
      detail as unknown as { ticket: { classification: { reasonCodes: string[] } } }
    ).ticket.classification;
    expect(classification.reasonCodes).toContain('classifier_unknown');
  });

  it('never auto-routes a security ticket (safety-critical)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: 'Hacked', body: 'I think my account was hacked' },
    });
    const { ticketId } = created.json() as { ticketId: string };
    const detail = await waitForStatus(app, ticketId, ['HUMAN_REVIEW', 'ROUTED']);
    expect(detail.ticket.status).toBe('HUMAN_REVIEW');
    expect(detail.ticket.team).toBe('human-review');
  });

  it('enforces the state machine on resolve and cancellations', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject: 'Invoice', body: 'Please send my invoice' },
    });
    const { ticketId } = created.json() as { ticketId: string };
    await waitForStatus(app, ticketId, ['ROUTED', 'HUMAN_REVIEW']);

    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ticketId}/resolve`,
      payload: { actor: 'agent-1', note: 'Sent the invoice' },
    });
    expect(resolved.statusCode).toBe(200);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ticketId}/resolve`,
      payload: { actor: 'agent-1' },
    });
    expect(again.statusCode).toBe(409);

    const illegal = await app.inject({
      method: 'POST',
      url: `/api/v1/support/tickets/${ticketId}/transitions`,
      payload: { to: 'ROUTED' },
    });
    expect(illegal.statusCode).toBe(409);
  });

  it('deduplicates ticket creation by idempotency key', async () => {
    const payload = {
      subject: 'Refund',
      body: 'I want a refund',
      idempotencyKey: `k6-${Date.now()}`,
    };
    const first = await app.inject({ method: 'POST', url: '/api/v1/support/tickets', payload });
    const second = await app.inject({ method: 'POST', url: '/api/v1/support/tickets', payload });
    const firstBody = first.json() as { ticketId: string; deduped?: boolean };
    const secondBody = second.json() as {
      ticketId: string;
      deduped?: boolean;
      runId: string | null;
    };
    expect(secondBody.ticketId).toBe(firstBody.ticketId);
    expect(secondBody.deduped).toBe(true);
    expect(secondBody.runId).toBeNull();
  });
});
