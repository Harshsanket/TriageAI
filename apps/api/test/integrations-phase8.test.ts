import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Capabilities, ClassificationResult, Kernel } from '@triageai/kernel';
import { PostgresDatabase } from '@triageai/kernel';

import { buildApp } from '../src/app.js';

const describeIfDb = process.env.SKIP_DB_TESTS === '1' ? describe.skip : describe;
const SUPPORT_CONFIG = path.resolve(process.cwd(), '../../config/presets/support.json');
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://triageai:triageai@localhost:5432/triageai';

type App = FastifyInstance & { kernel?: Kernel };

interface Action {
  id: string;
  ticketId: string;
  status: string;
  reason: string | null;
  ref: string | null;
}

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

interface MockGitHub {
  baseUrl: string;
  requests: RecordedRequest[];
  issues: Array<{ number: number; html_url: string; title: string; body: string; state: string }>;
  failCreates: number;
  createThenFail: number;
  close(): Promise<void>;
}

async function startMockGitHub(): Promise<MockGitHub> {
  const mock: MockGitHub = {
    baseUrl: '',
    requests: [],
    issues: [],
    failCreates: 0,
    createThenFail: 0,
    close: async () => undefined,
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        body = raw;
      }
      mock.requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body });
      const send = (status: number, payload: unknown): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? '/';

      if (req.method === 'POST' && url === '/repos/acme/app/issues') {
        const input = body as { title?: string; body?: string };
        if (mock.failCreates > 0) {
          mock.failCreates -= 1;
          send(500, { error: 'outage' });
          return;
        }
        const issue = {
          number: mock.issues.length + 1,
          html_url: `https://github.test/acme/app/issues/${mock.issues.length + 1}`,
          title: input.title ?? '',
          body: input.body ?? '',
          state: 'open',
        };
        mock.issues.push(issue);
        if (mock.createThenFail > 0) {
          mock.createThenFail -= 1;
          send(500, { error: 'lost response' });
          return;
        }
        send(201, { id: issue.number, number: issue.number, html_url: issue.html_url });
        return;
      }

      if (req.method === 'GET' && url.startsWith('/search/issues')) {
        const query = decodeURIComponent(new URL(url, 'http://mock').searchParams.get('q') ?? '');
        const marker = /triageai:ticket:([\w-]+) action:([\w-]+)/.exec(query);
        const subject = /in:title/.test(query);
        const matches = marker
          ? mock.issues.filter(
              (issue) =>
                issue.body.includes(`action:${marker[2]}`) &&
                issue.body.includes(`ticket:${marker[1]}`),
            )
          : subject
            ? mock.issues.filter((issue) => issue.title.includes(query.split('"')[1] ?? ''))
            : mock.issues;
        send(200, {
          items: matches.map((issue) => ({
            number: issue.number,
            html_url: issue.html_url,
            title: issue.title,
            body: issue.body,
          })),
        });
        return;
      }

      const patch = /^\/repos\/acme\/app\/issues\/(\d+)$/.exec(url);
      if (req.method === 'PATCH' && patch) {
        const issue = mock.issues.find((item) => item.number === Number(patch[1]));
        if (issue) issue.state = 'closed';
        send(200, { number: Number(patch[1]), html_url: issue?.html_url ?? '' });
        return;
      }

      send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return mock;
}

interface MockSlack {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startMockSlack(): Promise<MockSlack> {
  const mock: MockSlack = {
    baseUrl: '',
    requests: [],
    close: async () => undefined,
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw ? (JSON.parse(raw) as unknown) : null;
      } catch {
        body = raw;
      }
      mock.requests.push({ method: req.method ?? 'POST', url: req.url ?? '/', body });
      res.statusCode = 200;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mock.close = () =>
    new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return mock;
}

function classification(category: string): ClassificationResult {
  return {
    category,
    confidence: 0.93,
    margin: 0.4,
    method: 'zero-shot',
    modelVersion: 'fake-classifier',
    scores: [{ category, score: 0.93 }],
  };
}

describeIfDb('integrations + stress-visible side effects (phase 8)', () => {
  let app: App;
  let database: PostgresDatabase;
  let github: MockGitHub;
  let slack: MockSlack;
  let tmpDir: string;
  let configPath: string;
  let category = 'billing';

  beforeEach(async () => {
    category = 'billing';
    github = await startMockGitHub();
    slack = await startMockSlack();
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
    process.env.SLACK_WEBHOOK_URL = slack.baseUrl;

    tmpDir = await mkdtemp(path.join(tmpdir(), 'triageai-phase8-'));
    const raw = JSON.parse(await readFile(SUPPORT_CONFIG, 'utf8')) as {
      modules: Record<string, { enabled: boolean; options?: Record<string, unknown> }>;
    };
    raw.modules['integrations-github'] = {
      enabled: true,
      options: {
        repo: 'acme/app',
        baseUrl: github.baseUrl,
        requireApproval: false,
      },
    };
    raw.modules['integrations-slack'] = {
      enabled: true,
      options: {
        batchWindowMs: 0,
        dedupeWindowMs: 60_000,
        criticalChannel: '#incidents',
        routing: [{ categories: [], priorityCodes: ['P2'], channel: '#support' }],
      },
    };
    configPath = path.join(tmpDir, 'triage.config.test.json');
    await writeFile(configPath, JSON.stringify(raw));

    database = new PostgresDatabase(DATABASE_URL);
    // Drop jobs left by the previous test before booting: the new queue worker
    // would otherwise process them against this test's mock providers.
    await database.query(`DELETE FROM queue_jobs`).catch(() => undefined);
    await database.query(`DELETE FROM queue_deadletters`).catch(() => undefined);
    const capabilities: Capabilities = {
      classifier: { classify: async () => classification(category) },
    };
    app = (await buildApp({ quiet: true, configPath, capabilities })) as App;
    const db = app.kernel?.database as PostgresDatabase;
    await db.query(`DELETE FROM integration_github_links`);
    await db.query(`DELETE FROM integration_github_actions`);
    await db.query(`DELETE FROM integration_slack_actions`);
    await db.query(`DELETE FROM audit_events`);
    await db.query(`DELETE FROM support_auto_replies`);
    await db.query(`DELETE FROM support_ticket_messages`);
    await db.query(`DELETE FROM support_ticket_events`);
    await db.query(`DELETE FROM support_tickets`);
    await db.query(
      `DELETE FROM workflow_runs WHERE workflow_id LIKE 'integrations.%' OR workflow_id LIKE 'support.%'`,
    );
    await db.query(`DELETE FROM queue_jobs`);
  });

  afterEach(async () => {
    await app.close();
    await database.close();
    await github.close();
    await slack.close();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.SLACK_WEBHOOK_URL;
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createTicket(subject: string, body: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/support/tickets',
      payload: { subject, body },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { ticketId: string }).ticketId;
  }

  async function ticketStatus(ticketId: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: `/api/v1/support/tickets/${ticketId}` });
    return (res.json() as { ticket: { status: string } }).ticket.status;
  }

  async function waitForAction(
    provider: 'github' | 'slack',
    ticketId: string,
    statuses: string[],
    timeoutMs = 15000,
  ): Promise<Action> {
    const started = Date.now();
    for (;;) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/integrations/${provider}/actions`,
      });
      const actions = res.json() as Action[];
      const match = actions.find(
        (action) => action.ticketId === ticketId && statuses.includes(action.status),
      );
      if (match) return match;
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `timeout waiting for ${provider} action ${statuses.join('|')} (got ${JSON.stringify(actions)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('creates exactly one GitHub issue and records an audited link', async () => {
    const ticketId = await createTicket('Double charge', 'I was charged twice this month');
    const action = await waitForAction('github', ticketId, ['sent']);
    expect(action.ref).toMatch(/^acme\/app#\d+$/);
    expect(github.issues).toHaveLength(1);
    expect(github.requests.filter((request) => request.method === 'POST')).toHaveLength(1);

    const audit = await app.inject({ method: 'GET', url: '/api/v1/system/audit?limit=100' });
    expect(audit.statusCode).toBe(200);
    expect(JSON.stringify(audit.json())).toContain('integration.github.issue_linked');

    const detail = await app.inject({ method: 'GET', url: `/api/v1/support/tickets/${ticketId}` });
    const events = (detail.json() as { events: Array<{ type: string }> }).events.map(
      (event) => event.type,
    );
    expect(events).toContain('integration_issue_linked');
  });

  it('blocks outward GitHub action behind approval and sends only after approval', async () => {
    await app.close();
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      modules: Record<string, { enabled: boolean; options?: Record<string, unknown> }>;
    };
    config.modules['integrations-github'] = {
      enabled: true,
      options: {
        repo: 'acme/app',
        baseUrl: github.baseUrl,
        approvalCategories: ['billing'],
      },
    };
    await writeFile(configPath, JSON.stringify(config));
    app = (await buildApp({
      quiet: true,
      configPath,
      capabilities: {
        classifier: { classify: async () => classification(category) },
      },
    })) as App;

    const ticketId = await createTicket('Double charge', 'I was charged twice this month');
    const pending = await waitForAction('github', ticketId, ['pending_approval']);
    expect(github.requests).toHaveLength(0);

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/github/actions/${pending.id}/approve`,
      payload: { actor: 'admin' },
    });
    expect(approved.statusCode).toBe(200);
    await waitForAction('github', ticketId, ['sent']);
    expect(github.issues).toHaveLength(1);
  });

  it('keeps ticket state intact on outage and retries without a duplicate', async () => {
    github.failCreates = 10;
    const ticketId = await createTicket('Double charge', 'I was charged twice this month');
    const failed = await waitForAction('github', ticketId, ['failed']);
    expect(await ticketStatus(ticketId)).toBe('ROUTED');
    expect(github.issues).toHaveLength(0);

    github.failCreates = 0;
    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/github/actions/${failed.id}/retry`,
      payload: { actor: 'admin' },
    });
    expect(retried.statusCode).toBe(200);
    await waitForAction('github', ticketId, ['sent']);
    expect(github.issues).toHaveLength(1);
  });

  it('recovers a lost create response via marker search instead of duplicating', async () => {
    github.createThenFail = 1;
    const ticketId = await createTicket('Double charge', 'I was charged twice this month');
    const failed = await waitForAction('github', ticketId, ['failed']);
    expect(github.issues).toHaveLength(1);

    const retried = await app.inject({
      method: 'POST',
      url: `/api/v1/integrations/github/actions/${failed.id}/retry`,
      payload: { actor: 'admin' },
    });
    expect(retried.statusCode).toBe(200);
    const sent = await waitForAction('github', ticketId, ['sent']);
    expect(sent.ref).toBe('acme/app#1');
    expect(github.issues).toHaveLength(1);
    expect(github.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('syncs a linked GitHub issue closure back to the ticket', async () => {
    const ticketId = await createTicket('Double charge', 'I was charged twice this month');
    const action = await waitForAction('github', ticketId, ['sent']);
    const number = action.ref?.split('#')[1];
    const payload = JSON.stringify({
      action: 'closed',
      issue: { number: Number(number), html_url: `https://github.test/acme/app/issues/${number}` },
      repository: { full_name: 'acme/app' },
      sender: { login: 'octocat' },
    });
    const { createHmac } = await import('node:crypto');
    const signature = `sha256=${createHmac('sha256', 'test-secret').update(payload).digest('hex')}`;
    const hook = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/github/webhook',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-hub-signature-256': signature,
      },
    });
    expect(hook.statusCode).toBe(200);
    expect(await ticketStatus(ticketId)).toBe('RESOLVED');
  });

  it('sends critical Slack immediately, suppresses non-critical spam, and dedupes', async () => {
    category = 'general_question';
    const criticalId = await createTicket('Double charge', 'I was charged twice this month');
    await waitForAction('slack', criticalId, ['sent']);
    expect(slack.requests).toHaveLength(1);
    expect(JSON.stringify(slack.requests[0].body)).toContain('[CRITICAL]');

    const quietId = await createTicket('Question', 'help me understand the invoice');
    await waitForAction('slack', quietId, ['suppressed']);
    expect(slack.requests).toHaveLength(1);
  });

  it('batches non-critical notifications and flushes them on the policy window', async () => {
    await app.close();
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      modules: Record<string, { enabled: boolean; options?: Record<string, unknown> }>;
    };
    config.modules['integrations-slack'] = {
      enabled: true,
      options: {
        batchWindowMs: 100,
        dedupeWindowMs: 60_000,
        routing: [{ categories: [], priorityCodes: ['P2'], channel: '#support' }],
      },
    };
    await writeFile(configPath, JSON.stringify(config));
    app = (await buildApp({
      quiet: true,
      configPath,
      capabilities: {
        classifier: { classify: async () => classification(category) },
      },
    })) as App;

    category = 'general_question';
    const ticketId = await createTicket('App is broken with an error', 'It failed with an error');
    const sent = await waitForAction('slack', ticketId, ['sent'], 20000);
    expect(sent.status).toBe('sent');
    expect(slack.requests.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(slack.requests.at(-1)?.body)).toContain('Batched triage update');
  });
});
