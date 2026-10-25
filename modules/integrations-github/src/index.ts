/**
 * integrations-github (Phase 8): ticket → idempotent GitHub issue with an
 * optional per-category approval gate, duplicate search, linkbacks and
 * bidirectional status sync via signed webhooks. All outbound traffic goes
 * through the OutputChannel capability; tickets are only read from event
 * payloads (no cross-module DB access).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ulid } from 'ulid';

import { IntegrationActionDtoSchema, IntegrationApprovalRequestSchema } from '@triageai/contracts';
import { AppError } from '@triageai/kernel';
import type { KernelContext, TriageModule } from '@triageai/kernel';

import { createGitHubChannel } from './channel.js';

const configSchema = z
  .object({
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'repo must be owner/name')
      .default('local/triageai'),
    baseUrl: z.string().url().default('https://api.github.com'),
    channel: z.string().min(1).default('github-issue'),
    tokenEnv: z.string().min(1).default('GITHUB_TOKEN'),
    webhookSecretEnv: z.string().min(1).default('GITHUB_WEBHOOK_SECRET'),
    labels: z.array(z.string()).default(['triageai']),
    autoCreate: z.boolean().default(true),
    requireApproval: z.boolean().default(false),
    approvalCategories: z.array(z.string()).default([]),
    duplicateSearch: z.boolean().default(true),
    subjectSearch: z.boolean().default(true),
    closeOnResolved: z.boolean().default(true),
    requestTimeoutMs: z.number().int().positive().default(10_000),
  })
  .strict();

interface ActionRow {
  [key: string]: unknown;
  id: string;
  ticket_id: string;
  category: string | null;
  snapshot: TicketSnapshot;
  status: string;
  approval_required: boolean;
  labels: string[];
  reason: string | null;
  run_id: string | null;
  ref: string | null;
  url: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  [key: string]: unknown;
  id: string;
  ticket_id: string;
  issue_ref: string;
  issue_number: number;
  url: string | null;
  state: string;
}

interface TicketSnapshot {
  ticketId: string;
  status: string;
  subject: string;
  body: string;
  requester: string;
  category: string | null;
  confidence?: number;
  priorityCode?: string | null;
  teamId?: string | null;
  safetyCritical?: boolean;
  reasonCodes?: string[];
}

const MIGRATIONS = [
  {
    id: '0001-github-integration',
    sql: `
      CREATE TABLE IF NOT EXISTS integration_github_actions (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE,
        category TEXT,
        snapshot JSONB NOT NULL,
        status TEXT NOT NULL,
        approval_required BOOLEAN NOT NULL DEFAULT false,
        labels JSONB NOT NULL DEFAULT '[]'::jsonb,
        reason TEXT,
        run_id TEXT,
        ref TEXT,
        url TEXT,
        attempts INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS integration_github_actions_status
        ON integration_github_actions (status, created_at);

      CREATE TABLE IF NOT EXISTS integration_github_links (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL UNIQUE,
        issue_ref TEXT NOT NULL,
        issue_number INT NOT NULL,
        url TEXT,
        state TEXT NOT NULL DEFAULT 'open',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS integration_github_links_ref
        ON integration_github_links (issue_ref);
    `,
    dropSql: `
      DROP TABLE IF EXISTS integration_github_links;
      DROP TABLE IF EXISTS integration_github_actions;
    `,
  },
];

const markerFor = (actionId: string, ticketId: string): string =>
  `<!-- triageai:ticket:${ticketId} action:${actionId} -->`;

const actionDto = (row: ActionRow) =>
  IntegrationActionDtoSchema.parse({
    id: row.id,
    provider: 'github',
    ticketId: row.ticket_id,
    kind: 'issue',
    channel: 'github-issue',
    status: row.status,
    reason: row.reason,
    ref: row.ref,
    url: row.url,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });

export const integrationsGitHubModule: TriageModule = {
  id: 'integrations-github',
  version: '0.1.0',
  capabilities: ['storage', 'queue', 'eventBus', 'outputChannel'],
  dependsOn: {
    modules: [{ id: 'support', version: '^0.3.0' }],
    capabilities: [{ capability: 'outputChannel' }],
  },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['integration_github_actions', 'integration_github_links'],
  manifest: {
    routes: [{ path: '/integrations/github', title: 'GitHub integration' }],
    nav: [{ label: 'GitHub', order: 8, path: '/integrations/github' }],
    background: [],
  },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: 'github issue sync' }),
  },
  register(ctx: KernelContext) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const tokens = (ctx.env[options.tokenEnv] ?? '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
    const webhookSecret = ctx.env[options.webhookSecretEnv] ?? '';

    ctx.registerOutputChannel(
      options.channel,
      createGitHubChannel({
        repo: options.repo,
        baseUrl: options.baseUrl,
        channel: options.channel,
        tokens,
        requestTimeoutMs: options.requestTimeoutMs,
      }),
    );

    const audit = async (
      action: string,
      subject: string | null,
      payload: Record<string, unknown>,
      actor = 'system',
    ): Promise<void> => {
      await ctx.database.query(
        `INSERT INTO audit_events (id, actor, action, subject, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [ulid(), actor, action, subject, payload],
      );
    };

    const loadAction = async (id: string): Promise<ActionRow | undefined> => {
      const rows = await ctx.database.query<ActionRow>(
        `SELECT * FROM integration_github_actions WHERE id = $1`,
        [id],
      );
      return rows[0];
    };

    const dispatch = async (actionId: string): Promise<{ runId: string | null }> => {
      const rows = await ctx.database.query<ActionRow>(
        `UPDATE integration_github_actions
            SET attempts = attempts + 1, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [actionId],
      );
      const action = rows[0];
      if (!action) return { runId: null };
      const started = await ctx.queue.startWorkflow(
        'integrations.github.sync_issue',
        { actionId },
        {
          idempotencyKey: `github-issue:${actionId}:${action.attempts}`,
          trigger: 'event',
        },
      );
      await ctx.database.query(
        `UPDATE integration_github_actions SET run_id = $2, updated_at = now() WHERE id = $1`,
        [actionId, started.runId],
      );
      return { runId: started.runId };
    };

    const linkIssue = async (
      ticketId: string,
      ref: string,
      url: string | null,
      number: number | null,
    ): Promise<LinkRow> => {
      const rows = await ctx.database.query<LinkRow>(
        `INSERT INTO integration_github_links
           (id, ticket_id, issue_ref, issue_number, url, state)
         VALUES ($1, $2, $3, $4, $5, 'open')
         ON CONFLICT (ticket_id) DO UPDATE
           SET issue_ref = EXCLUDED.issue_ref,
               issue_number = EXCLUDED.issue_number,
               url = EXCLUDED.url,
               updated_at = now()
         RETURNING *`,
        [ulid(), ticketId, ref, number ?? 0, url],
      );
      return rows[0] as LinkRow;
    };

    const suppress = async (snapshot: TicketSnapshot, reason: string): Promise<void> => {
      await ctx.database.query(
        `INSERT INTO integration_github_actions
           (id, ticket_id, category, snapshot, status, reason, labels)
         VALUES ($1, $2, $3, $4, 'suppressed', $5, $6)
         ON CONFLICT (ticket_id) DO NOTHING`,
        [ulid(), snapshot.ticketId, snapshot.category, snapshot, reason, options.labels],
      );
      await audit('integration.github.suppressed', snapshot.ticketId, { reason });
    };

    ctx.events.subscribe('support.ticket.routed', async (raw) => {
      const snapshot = raw as TicketSnapshot;
      if (!snapshot?.ticketId) return;
      try {
        if (!options.autoCreate) {
          await suppress(snapshot, 'auto_create_disabled');
          return;
        }
        if (!snapshot.category) {
          await suppress(snapshot, 'category_missing');
          return;
        }
        const approvalRequired =
          options.requireApproval || options.approvalCategories.includes(snapshot.category);
        const status = approvalRequired ? 'pending_approval' : 'approved';
        const inserted = await ctx.database.query<ActionRow>(
          `INSERT INTO integration_github_actions
             (id, ticket_id, category, snapshot, status, approval_required, labels, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (ticket_id) DO NOTHING
           RETURNING *`,
          [
            ulid(),
            snapshot.ticketId,
            snapshot.category,
            snapshot,
            status,
            approvalRequired,
            options.labels,
            approvalRequired ? 'approval_required' : null,
          ],
        );
        const action = inserted[0];
        if (!action) return; // duplicate routed event
        await audit(
          approvalRequired ? 'integration.github.approval_requested' : 'integration.github.queued',
          snapshot.ticketId,
          { actionId: action.id, category: snapshot.category, priorityCode: snapshot.priorityCode },
        );
        if (!approvalRequired) await dispatch(action.id);
      } catch (err) {
        ctx.logger.error(
          { ticketId: snapshot.ticketId, err: (err as Error).message },
          'github integration failed to queue action',
        );
      }
    });

    ctx.events.subscribe('support.ticket.status_changed', async (raw) => {
      if (!options.closeOnResolved) return;
      const event = raw as { ticketId?: string; to?: string };
      if (event.to !== 'RESOLVED' || !event.ticketId) return;
      const links = await ctx.database.query<LinkRow>(
        `SELECT * FROM integration_github_links WHERE ticket_id = $1 AND state = 'open'`,
        [event.ticketId],
      );
      const link = links[0];
      if (!link) return;
      await ctx.queue.startWorkflow(
        'integrations.github.sync_status',
        { linkId: link.id, ticketId: event.ticketId },
        {
          idempotencyKey: `github-close:${link.id}:${link.issue_ref}`,
          trigger: 'event',
        },
      );
    });

    ctx.events.subscribe('workflow.run.finished', async (raw) => {
      const event = raw as {
        workflowId?: string;
        status?: string;
        error?: string | null;
        input?: unknown;
      };
      if (event.workflowId !== 'integrations.github.sync_issue' || event.status !== 'FAILED') {
        return;
      }
      const actionId = (event.input as { actionId?: string } | undefined)?.actionId;
      if (!actionId) return;
      await ctx.database.query(
        `UPDATE integration_github_actions
            SET status = 'failed', reason = $2, updated_at = now()
          WHERE id = $1 AND status <> 'sent'`,
        [actionId, event.error ?? 'delivery_failed'],
      );
      await audit('integration.github.delivery_failed', actionId, {
        error: event.error ?? null,
      });
    });

    ctx.registerStageHandler('integrations.github.sync_issue', {
      execute: async (stage) => {
        const input = stage.input as { actionId?: string };
        if (!input.actionId) throw new Error('integrations.github.sync_issue requires actionId');
        const action = await loadAction(input.actionId);
        if (!action) throw new Error(`github action ${input.actionId} not found`);
        if (action.status === 'sent') {
          return {
            output: { delivered: true, deduped: true, ref: action.ref, url: action.url },
            evidence: { kind: 'deterministic', deduped: true, ref: action.ref },
            deterministic: { deduped: true },
          };
        }
        if (action.status === 'pending_approval') {
          return {
            output: { delivered: false, awaitingApproval: true },
            evidence: { kind: 'deterministic', reason: 'approval_pending' },
            deterministic: { status: action.status },
          };
        }
        if (action.status !== 'approved' && action.status !== 'failed') {
          return {
            output: { delivered: false, skipped: true, reason: `status_${action.status}` },
            evidence: { kind: 'deterministic', reason: `status_${action.status}` },
            deterministic: { status: action.status },
          };
        }

        const marker = markerFor(action.id, action.ticket_id);
        const snapshot = action.snapshot;
        const channel = ctx.capabilities.outputChannel;
        if (!channel) throw new Error('outputChannel capability missing');

        let existing: { ref: string; url?: string; number?: number; reason: string } | null = null;
        if (options.duplicateSearch && channel.search) {
          const markerMatches = await channel.search(
            {
              runId: stage.runId,
              workflowId: stage.workflowId,
              stageId: stage.stageId,
              orgId: stage.orgId,
            },
            { channel: options.channel, text: marker, limit: 1, metadata: { mode: 'marker' } },
          );
          if (markerMatches[0]) {
            existing = {
              ref: markerMatches[0].ref,
              url: markerMatches[0].url,
              number: markerMatches[0].detail?.number as number | undefined,
              reason: 'existing_marker',
            };
          } else if (options.subjectSearch && snapshot.subject) {
            const titleMatches = await channel.search(
              {
                runId: stage.runId,
                workflowId: stage.workflowId,
                stageId: stage.stageId,
                orgId: stage.orgId,
              },
              {
                channel: options.channel,
                text: snapshot.subject,
                limit: 1,
                metadata: { mode: 'subject' },
              },
            );
            if (titleMatches[0]) {
              existing = {
                ref: titleMatches[0].ref,
                url: titleMatches[0].url,
                number: titleMatches[0].detail?.number as number | undefined,
                reason: 'existing_similar',
              };
            }
          }
        }

        const finish = async (
          ref: string,
          url: string | null,
          number: number | null,
          reason: string | null,
        ) => {
          await linkIssue(action.ticket_id, ref, url, number);
          await ctx.database.query(
            `UPDATE integration_github_actions
                SET status = 'sent', ref = $2, url = $3, reason = $4, updated_at = now()
              WHERE id = $1`,
            [action.id, ref, url, reason],
          );
          await audit('integration.github.issue_linked', action.ticket_id, {
            actionId: action.id,
            ref,
            url,
            reason,
          });
          await ctx.events.publish('integrations.github.issue_linked', {
            ticketId: action.ticket_id,
            ref,
            url,
            reason,
            actor: 'system',
          });
          return {
            output: { delivered: true, deduped: Boolean(reason), ref, url, reason },
            evidence: { kind: 'deterministic', ref, url, reason },
            deterministic: {
              existing: Boolean(reason),
              reason,
              labels: action.labels,
              duplicateSearch: options.duplicateSearch,
            },
          };
        };

        if (existing) {
          return finish(
            existing.ref,
            existing.url ?? null,
            existing.number ?? null,
            existing.reason,
          );
        }

        const delivered = await channel.deliver(
          {
            runId: stage.runId,
            workflowId: stage.workflowId,
            stageId: stage.stageId,
            orgId: stage.orgId,
          },
          {
            channel: options.channel,
            title: `[${action.ticket_id}] ${snapshot.subject}`,
            body: [
              snapshot.body,
              '',
              `Ticket: ${action.ticket_id}`,
              `Category: ${snapshot.category ?? 'unknown'} · Priority: ${snapshot.priorityCode ?? 'n/a'}`,
              marker,
            ].join('\n'),
            labels: action.labels,
            idempotencyKey: `github-issue:${action.id}`,
            metadata: { ticketId: action.ticket_id, actionId: action.id },
          },
        );
        const number = (delivered.detail?.number as number | undefined) ?? null;
        const url = (delivered.detail?.url as string | undefined) ?? null;
        return finish(delivered.ref, url, number, null);
      },
    });

    ctx.registerStageHandler('integrations.github.close_issue', {
      execute: async (stage) => {
        const input = stage.input as { linkId?: string; ticketId?: string };
        if (!input.linkId) throw new Error('integrations.github.close_issue requires linkId');
        const rows = await ctx.database.query<LinkRow>(
          `SELECT * FROM integration_github_links WHERE id = $1`,
          [input.linkId],
        );
        const link = rows[0];
        if (!link) throw new Error(`github link ${input.linkId} not found`);
        if (link.state === 'closed') {
          return {
            output: { closed: true, deduped: true, ref: link.issue_ref },
            evidence: { kind: 'deterministic', deduped: true },
          };
        }
        const channel = ctx.capabilities.outputChannel;
        if (!channel) throw new Error('outputChannel capability missing');
        const delivered = await channel.deliver(
          {
            runId: stage.runId,
            workflowId: stage.workflowId,
            stageId: stage.stageId,
            orgId: stage.orgId,
          },
          {
            channel: options.channel,
            body: `Ticket ${input.ticketId ?? link.ticket_id} resolved`,
            idempotencyKey: `github-close:${link.id}`,
            metadata: { operation: 'close', issueNumber: link.issue_number },
          },
        );
        await ctx.database.query(
          `UPDATE integration_github_links SET state = 'closed', updated_at = now() WHERE id = $1`,
          [link.id],
        );
        await audit('integration.github.issue_closed', link.ticket_id, {
          ref: link.issue_ref,
          url: link.url,
          deliveryRef: delivered.ref,
        });
        return {
          output: { closed: true, ref: link.issue_ref, deliveryRef: delivered.ref },
          evidence: { kind: 'deterministic', ref: link.issue_ref },
          deterministic: { operation: 'close', issueNumber: link.issue_number },
        };
      },
    });

    ctx.queue.start({
      id: 'integrations.github.sync_issue',
      module: 'integrations-github',
      version: '0.1.0',
      trigger: { type: 'event' },
      stages: [
        { id: 'sync', kind: 'integrations.github.sync_issue', input: { actionId: '$.actionId' } },
      ],
    });

    ctx.queue.start({
      id: 'integrations.github.sync_status',
      module: 'integrations-github',
      version: '0.1.0',
      trigger: { type: 'event' },
      stages: [
        {
          id: 'close',
          kind: 'integrations.github.close_issue',
          input: { linkId: '$.linkId', ticketId: '$.ticketId' },
        },
      ],
    });

    ctx.registerRoute({
      method: 'GET',
      url: '/api/v1/integrations/github/actions',
      handler: async (request) => {
        const status = request.query.status;
        const rows = await ctx.database.query<ActionRow>(
          `SELECT * FROM integration_github_actions
           WHERE ($1::text IS NULL OR status = $1)
           ORDER BY created_at DESC LIMIT 100`,
          [status ?? null],
        );
        return rows.map(actionDto);
      },
    });

    const transitionAction = async (
      id: string,
      from: string[],
      to: string,
      actor: string,
      action: string,
      note?: string,
    ): Promise<ActionRow> => {
      const current = await loadAction(id);
      if (!current) throw new AppError('NOT_FOUND', `github action ${id} not found`);
      if (!from.includes(current.status)) {
        if (current.status === to) return current;
        throw new AppError(
          'CONFLICT',
          `github action ${id} is ${current.status}; expected ${from.join('|')}`,
        );
      }
      const rows = await ctx.database.query<ActionRow>(
        `UPDATE integration_github_actions
            SET status = $2, reason = $3, updated_at = now()
          WHERE id = $1 AND status = ANY($4::text[])
          RETURNING *`,
        [id, to, note ?? null, from],
      );
      const updated = rows[0];
      if (!updated) throw new AppError('CONFLICT', `github action ${id} changed concurrently`);
      await audit(action, updated.ticket_id, { actionId: id, note: note ?? null }, actor);
      return updated;
    };

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/integrations/github/actions/:id/approve',
      handler: async (request) => {
        const body = IntegrationApprovalRequestSchema.parse(request.body ?? {});
        const action = await transitionAction(
          request.params.id as string,
          ['pending_approval', 'failed'],
          'approved',
          body.actor,
          'integration.github.approved',
          body.note,
        );
        await dispatch(action.id);
        return actionDto((await loadAction(action.id)) ?? action);
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/integrations/github/actions/:id/reject',
      handler: async (request) => {
        const body = IntegrationApprovalRequestSchema.parse(request.body ?? {});
        const action = await transitionAction(
          request.params.id as string,
          ['pending_approval', 'approved', 'failed'],
          'rejected',
          body.actor,
          'integration.github.rejected',
          body.note,
        );
        return actionDto(action);
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/integrations/github/actions/:id/retry',
      handler: async (request) => {
        const body = IntegrationApprovalRequestSchema.parse(request.body ?? {});
        const action = await transitionAction(
          request.params.id as string,
          ['failed'],
          'approved',
          body.actor,
          'integration.github.retried',
          body.note,
        );
        await dispatch(action.id);
        return actionDto((await loadAction(action.id)) ?? action);
      },
    });

    ctx.registerRoute({
      method: 'POST',
      url: '/api/v1/integrations/github/webhook',
      handler: async (request) => {
        if (!webhookSecret) {
          throw new AppError(
            'INTEGRATION_DISABLED',
            `webhook secret is not configured (${options.webhookSecretEnv})`,
            undefined,
            503,
          );
        }
        const signature = request.headers?.['x-hub-signature-256'];
        if (!signature || !request.rawBody) {
          throw new AppError('UNAUTHORIZED', 'missing webhook signature');
        }
        const expected = `sha256=${createHmac('sha256', webhookSecret).update(request.rawBody).digest('hex')}`;
        const expectedBuffer = Buffer.from(expected);
        const receivedBuffer = Buffer.from(signature);
        if (
          expectedBuffer.length !== receivedBuffer.length ||
          !timingSafeEqual(expectedBuffer, receivedBuffer)
        ) {
          throw new AppError('UNAUTHORIZED', 'invalid webhook signature');
        }

        const event = (request.headers?.['x-github-event'] ?? 'unknown') as string;
        const body = request.body as {
          action?: string;
          issue?: { number?: number; html_url?: string };
          repository?: { full_name?: string };
          sender?: { login?: string };
        };
        if (event === 'ping') return { ok: true, pong: true };
        if (event !== 'issues' || !body.issue?.number) return { ok: true, ignored: true };

        const mainChapter = body.repository?.full_name ?? options.repo;
        const issueRef = `${mainChapter}#${body.issue.number}`;
        const links = await ctx.database.query<LinkRow>(
          `SELECT * FROM integration_github_links
           WHERE issue_ref = $1 OR ($2::text IS NOT NULL AND url = $2) LIMIT 1`,
          [issueRef, body.issue.html_url ?? null],
        );
        const link = links[0];
        if (!link) return { ok: true, ignored: true, reason: 'unlinked_issue' };

        const actor = body.sender?.login ?? 'github';
        if (body.action === 'closed' || body.action === 'reopened') {
          await ctx.database.query(
            `UPDATE integration_github_links SET state = $2, updated_at = now() WHERE id = $1`,
            [link.id, body.action === 'closed' ? 'closed' : 'open'],
          );
          await ctx.events.publish(
            body.action === 'closed'
              ? 'integrations.github.issue_closed'
              : 'integrations.github.issue_reopened',
            { ticketId: link.ticket_id, ref: link.issue_ref, actor },
          );
          await audit(
            `integration.github.webhook_${body.action}`,
            link.ticket_id,
            { ref: link.issue_ref, actor },
            actor,
          );
        }
        return { ok: true, action: body.action ?? null, ref: link.issue_ref };
      },
    });
  },
};
