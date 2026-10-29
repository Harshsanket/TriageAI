/**
 * Shared plumbing for outward-integration modules (ADR-0018): audited action
 * rows with an approve / reject / retry lifecycle. Each provider module owns
 * its table and dispatch; this package owns the state guard, audit writes and
 * the admin routes so every provider behaves identically.
 */
import { ulid } from 'ulid';

import { IntegrationApprovalRequestSchema } from '@triageai/contracts';
import { AppError } from '@triageai/kernel';
import type { Database, KernelContext } from '@triageai/kernel';

/** Columns every provider action table has. */
export interface ActionRowBase {
  [key: string]: unknown;
  id: string;
  ticket_id: string;
  status: string;
}

export interface ActionStore<Row extends ActionRowBase> {
  load(id: string): Promise<Row | undefined>;
  /**
   * Move an action from one of `from` to `to` atomically and audit it. A
   * repeat of an already-applied transition is a no-op (idempotent clicks).
   */
  transition(args: {
    id: string;
    from: string[];
    to: string;
    actor: string;
    auditAction: string;
    note?: string;
  }): Promise<Row>;
  audit(
    action: string,
    subject: string | null,
    payload: Record<string, unknown>,
    actor?: string,
  ): Promise<void>;
}

const TABLE_NAME = /^[a-z][a-z0-9_]*$/;

export function createActionStore<Row extends ActionRowBase>(
  database: Database,
  provider: string,
  table: string,
): ActionStore<Row> {
  // The table name is module-declared, never request input, but it is
  // interpolated into SQL, so refuse anything that is not a plain identifier.
  if (!TABLE_NAME.test(table)) throw new Error(`invalid action table name: ${table}`);

  const audit: ActionStore<Row>['audit'] = async (action, subject, payload, actor = 'system') => {
    await database.query(
      `INSERT INTO audit_events (id, actor, action, subject, payload) VALUES ($1, $2, $3, $4, $5)`,
      [ulid(), actor, action, subject, payload],
    );
  };

  const load = async (id: string): Promise<Row | undefined> => {
    const rows = await database.query<Row>(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return rows[0];
  };

  return {
    load,
    audit,
    async transition({ id, from, to, actor, auditAction, note }) {
      const current = await load(id);
      if (!current) throw new AppError('NOT_FOUND', `${provider} action ${id} not found`);
      if (!from.includes(current.status)) {
        if (current.status === to) return current;
        throw new AppError(
          'CONFLICT',
          `${provider} action ${id} is ${current.status}; expected ${from.join('|')}`,
        );
      }
      const rows = await database.query<Row>(
        `UPDATE ${table}
            SET status = $2, reason = $3, updated_at = now()
          WHERE id = $1 AND status = ANY($4::text[])
          RETURNING *`,
        [id, to, note ?? null, from],
      );
      const updated = rows[0];
      if (!updated) throw new AppError('CONFLICT', `${provider} action ${id} changed concurrently`);
      await audit(auditAction, updated.ticket_id, { actionId: id, note: note ?? null }, actor);
      return updated;
    },
  };
}

export interface ActionRouteOptions<Row extends ActionRowBase> {
  /** URL and audit segment: `/api/v1/integrations/<provider>/actions`, `integration.<provider>.*`. */
  provider: string;
  table: string;
  store: ActionStore<Row>;
  /** Statuses an admin may reject from (providers add their own, e.g. `batched`). */
  rejectableStatuses: string[];
  toDto(row: Row): unknown;
  /** Re-run delivery for an approved action. */
  dispatch(actionId: string): Promise<unknown>;
}

/** `GET …/actions` plus `POST …/actions/:id/{approve,reject,retry}`. */
export function registerActionRoutes<Row extends ActionRowBase>(
  ctx: KernelContext,
  options: ActionRouteOptions<Row>,
): void {
  const { provider, table, store, toDto, dispatch } = options;
  const base = `/api/v1/integrations/${provider}/actions`;

  ctx.registerRoute({
    method: 'GET',
    url: base,
    handler: async (request) => {
      const rows = await ctx.database.query<Row>(
        `SELECT * FROM ${table}
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at DESC LIMIT 100`,
        [request.query.status ?? null],
      );
      return rows.map(toDto);
    },
  });

  const lifecycle: Array<{ verb: string; from: string[]; to: string; redeliver: boolean }> = [
    { verb: 'approve', from: ['pending_approval', 'failed'], to: 'approved', redeliver: true },
    { verb: 'reject', from: options.rejectableStatuses, to: 'rejected', redeliver: false },
    { verb: 'retry', from: ['failed'], to: 'approved', redeliver: true },
  ];
  const pastTense: Record<string, string> = {
    approve: 'approved',
    reject: 'rejected',
    retry: 'retried',
  };

  for (const step of lifecycle) {
    ctx.registerRoute({
      method: 'POST',
      url: `${base}/:id/${step.verb}`,
      handler: async (request) => {
        const body = IntegrationApprovalRequestSchema.parse(request.body ?? {});
        const action = await store.transition({
          id: request.params.id as string,
          from: step.from,
          to: step.to,
          actor: request.actor ?? body.actor,
          auditAction: `integration.${provider}.${pastTense[step.verb]}`,
          note: body.note,
        });
        if (!step.redeliver) return toDto(action);
        await dispatch(action.id);
        return toDto((await store.load(action.id)) ?? action);
      },
    });
  }
}
