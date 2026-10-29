/**
 * integrations-slack (Phase 8): policy-based ticket notifications. Critical
 * signals (safety-critical or P0/P1) go out immediately; everything else is
 * either batched by channel or suppressed by policy. A dedupe window prevents
 * notification spam, and an optional approval gate blocks outward sends.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ulid } from 'ulid';

import { IntegrationActionDtoSchema, TicketPriorityCodeSchema } from '@triageai/contracts';
import { createActionStore, registerActionRoutes } from '@triageai/integrations-core';
import type { KernelContext, TriageModule } from '@triageai/kernel';

import { createSlackChannel } from './channel.js';

const routingRuleSchema = z
  .object({
    categories: z.array(z.string()).default([]),
    priorityCodes: z.array(TicketPriorityCodeSchema).default([]),
    channel: z.string().min(1),
  })
  .strict();

const configSchema = z
  .object({
    webhookUrlEnv: z.string().min(1).default('SLACK_WEBHOOK_URL'),
    channel: z.string().min(1).default('slack-message'),
    criticalChannel: z.string().min(1).default('#incidents'),
    routing: z
      .array(routingRuleSchema)
      .default([{ categories: [], priorityCodes: ['P0', 'P1'], channel: '#incidents' }]),
    batchWindowMs: z.number().int().min(0).default(60_000),
    dedupeWindowMs: z.number().int().min(0).default(300_000),
    requireApproval: z.boolean().default(false),
    approvalCategories: z.array(z.string()).default([]),
    ticketUrlTemplate: z.string().default('http://localhost:5173/support?ticketId={ticketId}'),
  })
  .strict();

type SlackOptions = z.infer<typeof configSchema>;

interface TicketSnapshot {
  ticketId: string;
  status: string;
  subject: string;
  body: string;
  category: string | null;
  priorityCode?: string | null;
  teamId?: string | null;
  safetyCritical?: boolean;
  reasonCodes?: string[];
}

interface ActionRow {
  [key: string]: unknown;
  id: string;
  ticket_id: string;
  category: string | null;
  priority_code: string | null;
  channel: string;
  snapshot: TicketSnapshot;
  text: string;
  status: string;
  reason: string | null;
  run_id: string | null;
  ref: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

const MIGRATIONS = [
  {
    id: '0001-slack-integration',
    sql: `
      CREATE TABLE IF NOT EXISTS integration_slack_actions (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        ticket_id TEXT NOT NULL,
        category TEXT,
        priority_code TEXT,
        channel TEXT NOT NULL,
        snapshot JSONB NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        run_id TEXT,
        ref TEXT,
        attempts INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS integration_slack_actions_status
        ON integration_slack_actions (status, created_at);
      CREATE INDEX IF NOT EXISTS integration_slack_actions_ticket
        ON integration_slack_actions (ticket_id, channel, created_at);
    `,
    dropSql: `DROP TABLE IF EXISTS integration_slack_actions;`,
  },
];

const actionDto = (row: ActionRow) =>
  IntegrationActionDtoSchema.parse({
    id: row.id,
    provider: 'slack',
    ticketId: row.ticket_id,
    kind: 'message',
    channel: row.channel,
    status: row.status,
    reason: row.reason,
    ref: row.ref,
    url: null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });

const isCritical = (snapshot: TicketSnapshot): boolean =>
  Boolean(snapshot.safetyCritical) ||
  snapshot.priorityCode === 'P0' ||
  snapshot.priorityCode === 'P1';

const matchesRule = (rule: z.infer<typeof routingRuleSchema>, snapshot: TicketSnapshot): boolean =>
  (rule.categories.length === 0 && rule.priorityCodes.length === 0) ||
  (snapshot.category !== null && rule.categories.includes(snapshot.category)) ||
  (snapshot.priorityCode !== null &&
    snapshot.priorityCode !== undefined &&
    rule.priorityCodes.includes(snapshot.priorityCode as z.infer<typeof TicketPriorityCodeSchema>));

const textFor = (snapshot: TicketSnapshot, options: SlackOptions): string => {
  const url = options.ticketUrlTemplate.replace('{ticketId}', snapshot.ticketId);
  const priority = snapshot.priorityCode ?? 'n/a';
  const category = snapshot.category ?? 'unknown';
  return [
    `${isCritical(snapshot) ? '[CRITICAL] ' : ''}[${priority}] ${snapshot.subject}`,
    `Category: ${category} · Team: ${snapshot.teamId ?? 'unassigned'}`,
    `Ticket: ${url}`,
    '',
    snapshot.body.slice(0, 600),
  ].join('\n');
};

let flushTimer: ReturnType<typeof setInterval> | undefined;

export const integrationsSlackModule: TriageModule = {
  id: 'integrations-slack',
  version: '0.1.0',
  capabilities: ['storage', 'queue', 'eventBus', 'outputChannel'],
  dependsOn: {
    modules: [{ id: 'support', version: '^0.3.0' }],
    capabilities: [{ capability: 'outputChannel' }],
  },
  configSchema,
  migrations: MIGRATIONS,
  tables: ['integration_slack_actions'],
  manifest: {
    routes: [{ path: '/integrations/slack', title: 'Slack integration' }],
    nav: [{ label: 'Slack', order: 9, path: '/integrations/slack' }],
    background: [],
  },
  lifecycle: {
    health: async () => ({ status: 'healthy', detail: 'slack notifications' }),
    onStop: async () => {
      if (flushTimer) clearInterval(flushTimer);
      flushTimer = undefined;
    },
  },
  register(ctx: KernelContext) {
    const options = configSchema.parse(ctx.moduleOptions ?? {});
    const webhookUrl = ctx.env[options.webhookUrlEnv] ?? '';

    ctx.registerOutputChannel(
      options.channel,
      createSlackChannel({ webhookUrl, channel: options.channel }),
    );

    const actions = createActionStore<ActionRow>(
      ctx.database,
      'slack',
      'integration_slack_actions',
    );
    const audit = actions.audit;
    const loadAction = actions.load;

    const dispatch = async (actionId: string): Promise<{ runId: string | null }> => {
      const rows = await ctx.database.query<ActionRow>(
        `UPDATE integration_slack_actions
            SET attempts = attempts + 1, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [actionId],
      );
      const action = rows[0];
      if (!action) return { runId: null };
      const started = await ctx.queue.startWorkflow(
        'integrations.slack.notify',
        { actionId },
        {
          idempotencyKey: `slack-action:${actionId}:${action.attempts}`,
          trigger: 'event',
        },
      );
      await ctx.database.query(
        `UPDATE integration_slack_actions SET run_id = $2, updated_at = now() WHERE id = $1`,
        [actionId, started.runId],
      );
      return { runId: started.runId };
    };

    const recentDuplicate = async (ticketId: string, channel: string): Promise<boolean> => {
      if (options.dedupeWindowMs === 0) return false;
      const rows = await ctx.database.query<{ id: string }>(
        `SELECT id FROM integration_slack_actions
         WHERE ticket_id = $1 AND channel = $2 AND status = 'sent'
           AND updated_at > now() - ($3::int * interval '1 millisecond')
         LIMIT 1`,
        [ticketId, channel, options.dedupeWindowMs],
      );
      return Boolean(rows[0]);
    };

    const suppress = async (
      snapshot: TicketSnapshot,
      channel: string,
      reason: string,
      dedupeKey: string,
    ): Promise<void> => {
      await ctx.database.query(
        `INSERT INTO integration_slack_actions
           (id, dedupe_key, ticket_id, category, priority_code, channel, snapshot, text, status, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'suppressed', $9)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          ulid(),
          dedupeKey,
          snapshot.ticketId,
          snapshot.category,
          snapshot.priorityCode ?? null,
          channel,
          snapshot,
          textFor(snapshot, options),
          reason,
        ],
      );
      await audit('integration.slack.suppressed', snapshot.ticketId, { reason, channel });
    };

    ctx.events.subscribe('support.ticket.routed', async (raw) => {
      const snapshot = raw as TicketSnapshot;
      if (!snapshot?.ticketId) return;
      try {
        const critical = isCritical(snapshot);
        const rule = options.routing.find((candidate) => matchesRule(candidate, snapshot));
        const channel = critical ? options.criticalChannel : rule?.channel;
        if (!channel) {
          await suppress(
            snapshot,
            options.criticalChannel,
            'policy_no_match',
            `no-match:${snapshot.ticketId}`,
          );
          return;
        }
        if (await recentDuplicate(snapshot.ticketId, channel)) {
          await suppress(
            snapshot,
            channel,
            'dedupe_window',
            `dedupe:${snapshot.ticketId}:${channel}:${Math.floor(Date.now() / options.dedupeWindowMs)}`,
          );
          return;
        }

        const text = textFor(snapshot, options);
        const dedupeKey = createHash('sha256')
          .update(`${snapshot.ticketId}\n${channel}\n${text}`)
          .digest('hex');
        const approvalRequired =
          options.requireApproval ||
          (snapshot.category !== null && options.approvalCategories.includes(snapshot.category));
        const status = approvalRequired
          ? 'pending_approval'
          : critical || options.batchWindowMs === 0
            ? 'approved'
            : 'batched';
        const inserted = await ctx.database.query<ActionRow>(
          `INSERT INTO integration_slack_actions
             (id, dedupe_key, ticket_id, category, priority_code, channel, snapshot, text, status, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (dedupe_key) DO NOTHING
           RETURNING *`,
          [
            ulid(),
            dedupeKey,
            snapshot.ticketId,
            snapshot.category,
            snapshot.priorityCode ?? null,
            channel,
            snapshot,
            text,
            status,
            approvalRequired ? 'approval_required' : null,
          ],
        );
        const action = inserted[0];
        if (!action) return;
        await audit(
          approvalRequired
            ? 'integration.slack.approval_requested'
            : status === 'approved'
              ? 'integration.slack.queued'
              : 'integration.slack.batched',
          snapshot.ticketId,
          { actionId: action.id, channel, critical },
        );
        if (status === 'approved') await dispatch(action.id);
      } catch (err) {
        ctx.logger.error(
          { ticketId: snapshot.ticketId, err: (err as Error).message },
          'slack integration failed to queue action',
        );
      }
    });

    ctx.events.subscribe('workflow.run.finished', async (raw) => {
      const event = raw as {
        workflowId?: string;
        status?: string;
        error?: string | null;
        input?: unknown;
      };
      if (event.workflowId !== 'integrations.slack.notify' || event.status !== 'FAILED') return;
      const actionId = (event.input as { actionId?: string } | undefined)?.actionId;
      if (!actionId) return;
      await ctx.database.query(
        `UPDATE integration_slack_actions
            SET status = 'failed', reason = $2, updated_at = now()
          WHERE id = $1 AND status <> 'sent'`,
        [actionId, event.error ?? 'delivery_failed'],
      );
      await audit('integration.slack.delivery_failed', actionId, { error: event.error ?? null });
    });

    ctx.registerStageHandler('integrations.slack.notify', {
      execute: async (stage) => {
        const input = stage.input as { actionId?: string };
        if (!input.actionId) throw new Error('integrations.slack.notify requires actionId');
        const action = await loadAction(input.actionId);
        if (!action) throw new Error(`slack action ${input.actionId} not found`);
        if (action.status === 'sent') {
          return {
            output: { sent: true, deduped: true, ref: action.ref },
            evidence: { kind: 'deterministic', deduped: true, ref: action.ref },
            deterministic: { deduped: true },
          };
        }
        if (action.status === 'pending_approval' || action.status === 'batched') {
          return {
            output: { sent: false, skipped: true, reason: action.status },
            evidence: { kind: 'deterministic', reason: action.status },
            deterministic: { status: action.status },
          };
        }
        if (action.status !== 'approved' && action.status !== 'failed') {
          return {
            output: { sent: false, skipped: true, reason: `status_${action.status}` },
            evidence: { kind: 'deterministic', reason: `status_${action.status}` },
            deterministic: { status: action.status },
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
            body: action.text,
            idempotencyKey: `slack-action:${action.id}`,
            metadata: { ticketId: action.ticket_id, slackChannel: action.channel },
          },
        );
        await ctx.database.query(
          `UPDATE integration_slack_actions
              SET status = 'sent', ref = $2, reason = 'notified', updated_at = now()
            WHERE id = $1`,
          [action.id, delivered.ref],
        );
        await audit('integration.slack.sent', action.ticket_id, {
          actionId: action.id,
          channel: action.channel,
          ref: delivered.ref,
          critical: isCritical(action.snapshot),
        });
        return {
          output: { sent: true, ref: delivered.ref, channel: action.channel },
          evidence: { kind: 'deterministic', ref: delivered.ref },
          deterministic: { channel: action.channel, critical: isCritical(action.snapshot) },
        };
      },
    });

    ctx.registerStageHandler('integrations.slack.flush_batch', {
      execute: async (stage) => {
        const rows = await ctx.database.query<ActionRow>(
          `SELECT * FROM integration_slack_actions
           WHERE status = 'batched'
           ORDER BY created_at ASC LIMIT 100`,
        );
        if (rows.length === 0) {
          return {
            output: { flushed: 0 },
            evidence: { kind: 'deterministic', flushed: 0 },
            deterministic: { groups: 0 },
          };
        }
        const groups = new Map<string, ActionRow[]>();
        for (const row of rows) {
          const bucket = groups.get(row.channel) ?? [];
          bucket.push(row);
          groups.set(row.channel, bucket);
        }
        const channel = ctx.capabilities.outputChannel;
        if (!channel) throw new Error('outputChannel capability missing');
        let flushed = 0;
        const failures: string[] = [];
        for (const [slackChannel, actions] of groups) {
          const body = [
            `Batched triage update (${actions.length} ticket${actions.length === 1 ? '' : 's'})`,
            ...actions.map(
              (action) => `• [${action.priority_code ?? 'n/a'}] ${action.snapshot.subject}`,
            ),
          ].join('\n');
          try {
            const delivered = await channel.deliver(
              {
                runId: stage.runId,
                workflowId: stage.workflowId,
                stageId: stage.stageId,
                orgId: stage.orgId,
              },
              {
                channel: options.channel,
                body,
                idempotencyKey: `slack-batch:${slackChannel}:${actions
                  .map((a) => a.id)
                  .sort()
                  .join(',')}`,
                metadata: { slackChannel, count: actions.length, batched: true },
              },
            );
            await ctx.database.query(
              `UPDATE integration_slack_actions
                  SET status = 'sent', ref = $2, reason = 'batched', updated_at = now()
                WHERE id = ANY($1::text[])`,
              [actions.map((action) => action.id), delivered.ref],
            );
            flushed += actions.length;
            await audit('integration.slack.batch_sent', slackChannel, {
              actionIds: actions.map((action) => action.id),
              ref: delivered.ref,
            });
          } catch (err) {
            const message = (err as Error).message;
            failures.push(`${slackChannel}: ${message}`);
            await ctx.database.query(
              `UPDATE integration_slack_actions
                  SET status = 'failed', reason = $2, updated_at = now()
                WHERE id = ANY($1::text[])`,
              [actions.map((action) => action.id), message],
            );
            await audit('integration.slack.batch_failed', slackChannel, {
              actionIds: actions.map((action) => action.id),
              error: message,
            });
          }
        }
        return {
          output: { flushed, failedGroups: failures.length },
          evidence: { kind: 'deterministic', flushed, failures },
          deterministic: { groups: groups.size },
        };
      },
    });

    ctx.queue.start({
      id: 'integrations.slack.notify',
      module: 'integrations-slack',
      version: '0.1.0',
      trigger: { type: 'event' },
      stages: [
        { id: 'send', kind: 'integrations.slack.notify', input: { actionId: '$.actionId' } },
      ],
    });

    ctx.queue.start({
      id: 'integrations.slack.flush',
      module: 'integrations-slack',
      version: '0.1.0',
      trigger: { type: 'schedule' },
      stages: [{ id: 'flush', kind: 'integrations.slack.flush_batch' }],
    });

    if (options.batchWindowMs > 0) {
      flushTimer = setInterval(() => {
        const bucket = Math.floor(Date.now() / options.batchWindowMs);
        void ctx.queue
          .startWorkflow(
            'integrations.slack.flush',
            { window: bucket },
            { idempotencyKey: `slack-flush:${bucket}`, trigger: 'schedule' },
          )
          .catch((err: Error) => {
            ctx.logger.warn({ err: err.message }, 'slack batch flush dispatch failed');
          });
      }, options.batchWindowMs);
      flushTimer.unref?.();
    }

    registerActionRoutes(ctx, {
      provider: 'slack',
      table: 'integration_slack_actions',
      store: actions,
      rejectableStatuses: ['pending_approval', 'approved', 'failed', 'batched'],
      toDto: actionDto,
      dispatch,
    });
  },
};
