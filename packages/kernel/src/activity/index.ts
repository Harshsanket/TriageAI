/** Activity search helpers (Phase 18.6): deterministic dates, writes, queries. */
import { ulid } from 'ulid';

import {
  ActivityEventSchema,
  ActivityKindSchema,
  ActivityQuerySchema,
  emptyActivityQuery,
} from '@triageai/contracts';
import type { ActivityEvent, ActivityKind, ActivityQuery } from '@triageai/contracts';

import { callModel, type ModelTask } from '../models/callModel.js';
import type { ChatModel, Database } from '../types.js';

/** Parse relative dates before any model runs; unknown phrases return null. */
export function activityRange(
  phrase: string,
  now = new Date(),
  timeZone?: string,
): { from: string; to: string } | null {
  const lower = phrase.toLowerCase();
  const day = (offsetDays: number) => {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() + offsetDays);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  };
  if (/\byesterday\b/.test(lower)) return day(-1);
  if (/\btoday\b/.test(lower)) return day(0);
  if (/\blast week\b/.test(lower)) {
    const end = day(0);
    const start = day(-7);
    return { from: start.from, to: end.from };
  }
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(phrase);
  if (iso?.[1]) {
    const start = new Date(`${iso[1]}T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { from: start.toISOString(), to: end.toISOString() };
  }
  void timeZone;
  return null;
}

const ACTIVITY_STOPWORDS = new Set([
  'a',
  'activity',
  'all',
  'an',
  'and',
  'any',
  'at',
  'did',
  'do',
  'done',
  'for',
  'from',
  'happen',
  'happened',
  'in',
  'is',
  'last',
  'of',
  'on',
  'or',
  'show',
  'the',
  'to',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'work',
  'yesterday',
  'today',
  'week',
]);

function stripDateWords(phrase: string): string | undefined {
  const words = phrase
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !ACTIVITY_STOPWORDS.has(word));
  const text = words.join(' ').trim();
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

/**
 * Deterministic first pass: dates, kinds and a keyword fallback. Returns null
 * when the phrase needs the model to fill the filter schema.
 */
export function parseActivityPhrase(
  phrase: string,
  now = new Date(),
  timeZone?: string,
): ActivityQuery | null {
  const range = activityRange(phrase, now, timeZone);
  const lower = phrase.toLowerCase();
  const kinds = ActivityKindSchema.options.filter((kind) =>
    new RegExp(`\\b${kind}s?\\b`).test(lower),
  );
  let text = stripDateWords(phrase);
  if (text) {
    for (const kind of kinds) {
      text = text
        .replace(new RegExp(`\\b${kind}s?\\b`, 'g'), ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    if (text.length === 0) text = undefined;
  }
  if (!range) return null;
  return ActivityQuerySchema.parse({
    timeRange: range,
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(text ? { text } : {}),
  });
}

export interface ActivityWrite {
  at?: Date | string;
  actor?: string | null;
  kind: ActivityKind;
  subject: string;
  summary: string;
  refs?: string[];
}

/** Best-effort write: activity must never fail the business write it describes. */
export async function recordActivity(database: Database, event: ActivityWrite): Promise<boolean> {
  try {
    await database.query(
      `INSERT INTO activity_events (id, at, actor, kind, subject, summary, refs)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7)`,
      [
        ulid(),
        event.at ?? null,
        event.actor ?? 'system',
        event.kind,
        event.subject,
        event.summary,
        event.refs ?? [],
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export interface ActivityRow extends ActivityEvent {
  id: string;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export async function queryActivity(
  database: Database,
  query: ActivityQuery,
  limit = 100,
): Promise<ActivityRow[]> {
  const params: unknown[] = [query.timeRange.from, query.timeRange.to];
  const where = ['at >= $1', 'at < $2'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (query.kinds?.length) add('kind = ANY(?::text[])', query.kinds);
  if (query.actors?.length) add('actor = ANY(?::text[])', query.actors);
  if (query.agentIds?.length) add('jsonb_exists_any(refs, ?::text[])', query.agentIds);
  if (query.modules?.length) add('jsonb_exists_any(refs, ?::text[])', query.modules);
  if (query.text) {
    const pattern = `%${escapeLike(query.text)}%`;
    params.push(pattern);
    const placeholder = `$${params.length}`;
    where.push(
      `(summary ILIKE ${placeholder} ESCAPE '\\' OR subject ILIKE ${placeholder} ESCAPE '\\' OR actor ILIKE ${placeholder} ESCAPE '\\')`,
    );
  }
  const bounded = Math.min(Math.max(1, Math.trunc(limit)), 500);
  params.push(bounded);
  const rows = await database.query<{
    id: string;
    at: Date | string;
    actor: string;
    kind: string;
    subject: string;
    summary: string;
    refs: unknown;
  }>(
    `SELECT id, at, actor, kind, subject, summary, refs
       FROM activity_events
      WHERE ${where.join(' AND ')}
      ORDER BY at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    ...ActivityEventSchema.parse({
      at: new Date(row.at).toISOString(),
      actor: row.actor,
      kind: row.kind,
      subject: row.subject,
      summary: row.summary,
      refs: Array.isArray(row.refs) ? row.refs : [],
    }),
  }));
}

const ACTIVITY_TASK: ModelTask = {
  id: 'activity_search',
  promptTemplateId: 'activity.search',
  promptVersion: '1',
  outputSchema: ActivityQuerySchema,
  maxOutputTokens: 256,
  timeoutMs: 30_000,
  requiredFields: [],
};

export interface ActivityQueryResolution {
  query: ActivityQuery;
  source: 'deterministic' | 'model' | 'keyword';
}

/**
 * Resolve a natural-language question to a filter. Dates and obvious kinds are
 * deterministic; the model is asked at most once (and never when the global
 * LLM switch is off). Any invalid model output falls back to keyword search.
 */
export async function resolveActivityQuery(args: {
  phrase: string;
  now?: Date;
  timeZone?: string;
  chatModel?: ChatModel;
  llmDisabled?: boolean;
}): Promise<ActivityQueryResolution> {
  const now = args.now ?? new Date();
  const deterministic = parseActivityPhrase(args.phrase, now, args.timeZone);
  if (deterministic) return { query: deterministic, source: 'deterministic' };

  if (args.chatModel && !args.llmDisabled) {
    try {
      const result = await callModel(
        { chatModel: args.chatModel },
        ACTIVITY_TASK,
        {
          runId: 'activity-search',
          workflowId: 'activity',
          workflowVersion: '1',
          stepName: 'activity_search',
        },
        {
          messages: [
            {
              role: 'system',
              content:
                'Convert the question into an activity filter. Return only JSON with ' +
                'timeRange {from,to} (ISO 8601), optional actors[], kinds[], text (max 200).',
            },
            { role: 'user', content: args.phrase.slice(0, 500) },
          ],
          structured: true,
          temperature: 0,
          sendGate: { sensitivity: 'restricted', modelUse: 'local_only' },
        },
      );
      const parsed = ActivityQuerySchema.safeParse(result.parsed);
      if (parsed.success) {
        const from = Date.parse(parsed.data.timeRange.from);
        const to = Date.parse(parsed.data.timeRange.to);
        if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
          return { query: parsed.data, source: 'model' };
        }
      }
    } catch {
      // Fall through to keyword search; the caller still gets an answer.
    }
  }

  const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return {
    query: {
      ...emptyActivityQuery(from.toISOString(), now.toISOString()),
      text: args.phrase.slice(0, 200),
    },
    source: 'keyword',
  };
}

export interface ActivityDigest {
  date: string;
  counts: Partial<Record<ActivityKind, number>>;
  events: ActivityEvent[];
}

export function digestEvents(events: ActivityEvent[], date: string): ActivityDigest {
  const counts: Partial<Record<ActivityKind, number>> = {};
  for (const event of events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return { date, counts, events };
}

export function answerFromDigest(digest: ActivityDigest, dateLabel: string): string {
  const entries = Object.entries(digest.counts);
  if (entries.length === 0) return `No recorded activity on ${dateLabel}.`;
  const parts = entries.map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`);
  return `${dateLabel}: ${parts.join(', ')}.`;
}
