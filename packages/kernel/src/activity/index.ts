/** Activity search helpers (Phase 18.6): deterministic dates and digests. */
import type { ActivityEvent, ActivityKind } from '@triageai/contracts';

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
