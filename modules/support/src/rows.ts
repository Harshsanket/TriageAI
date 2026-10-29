/** Row shapes for support tables and their DTO mappers. */
import { AutoReplyPolicyDtoSchema } from '@triageai/contracts';

export interface TicketRow {
  [key: string]: unknown;
  id: string;
  subject: string;
  body: string;
  requester: string;
  status: string;
  category: string | null;
  confidence: number | null;
  margin: number | null;
  priority: string | null;
  team: string | null;
  priority_code: string | null;
  team_id: string | null;
  classification: Record<string, unknown> | null;
  routing: Record<string, unknown> | null;
  triage: Record<string, unknown> | null;
  auto_reply: Record<string, unknown> | null;
  owner_id?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/** True when the caller is unscoped (agent/admin) or owns the ticket. */
export const ownedBy = (ticket: TicketRow, ownerScope: string | undefined): boolean =>
  ownerScope === undefined || ticket.owner_id === ownerScope;

export interface PolicyRow {
  [key: string]: unknown;
  category: string;
  version: number;
  enabled: boolean;
  fallback_policy: string;
  collection: string;
  max_answer_chars: number;
  note: string | null;
  updated_by: string | null;
  created_at: Date | string;
}

export interface AutoReplyRow {
  [key: string]: unknown;
  id: string;
  ticket_id: string;
  run_id: string | null;
  answer: string;
  answer_hash: string;
  citations: string[] | null;
  state: string;
  reason: string | null;
  created_at: Date | string;
}

export const ticketDto = (row: TicketRow) => ({
  id: row.id,
  subject: row.subject,
  body: row.body,
  requester: row.requester,
  status: row.status,
  category: row.category,
  confidence: row.confidence,
  margin: row.margin,
  priority: row.priority,
  team: row.team,
  priorityCode: row.priority_code,
  teamId: row.team_id,
  classification: row.classification,
  routing: row.routing,
  triage: row.triage ?? null,
  autoReply: row.auto_reply ?? null,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

export const policyDto = (row: PolicyRow) =>
  AutoReplyPolicyDtoSchema.parse({
    category: row.category,
    version: row.version,
    enabled: row.enabled,
    fallbackPolicy: row.fallback_policy,
    collection: row.collection,
    maxAnswerChars: row.max_answer_chars,
    note: row.note,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at).toISOString(),
  });
