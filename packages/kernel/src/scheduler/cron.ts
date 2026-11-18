/**
 * Five-field cron (18.T4): minute hour day-of-month month day-of-week, UTC.
 * No dependency, no seconds. Supports `*`, lists (`a,b`), ranges (`a-b`) and
 * steps (`* /n`, `a-b/n`, `a/n`). Day-of-week accepts 0–7 (0 and 7 = Sunday).
 *
 * Day-of-month / day-of-week follow the standard cron rule: when both fields
 * are restricted the day matches if either matches; otherwise the restricted
 * field alone decides.
 */
import { AppError } from '../errors.js';

export interface CronSpec {
  expression: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

interface FieldRange {
  min: number;
  max: number;
  /** Normalise a value (day-of-week 7 → 0). */
  normalise?: (value: number) => number;
}

const FIELDS: FieldRange[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7, normalise: (value) => (value === 7 ? 0 : value) },
];

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];

function parseField(text: string, index: number): { values: number[]; restricted: boolean } {
  const range = FIELDS[index] as FieldRange;
  const name = FIELD_NAMES[index] as string;
  const values = new Set<number>();
  const restricted = text !== '*';
  for (const part of text.split(',')) {
    if (!part) throw cronError(`empty ${name} list item`);
    const [base, stepText, ...rest] = part.split('/');
    if (rest.length > 0) throw cronError(`invalid ${name} step "${part}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) {
      throw cronError(`invalid ${name} step "${part}"`);
    }
    let start: number;
    let end: number;
    if (base === '*') {
      start = range.min;
      end = range.max;
    } else if (base?.includes('-')) {
      const [left, right] = base.split('-');
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(base);
      end = stepText === undefined ? start : range.max;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < range.min ||
      end > range.max ||
      start > end
    ) {
      throw cronError(`invalid ${name} value "${part}" (expected ${range.min}-${range.max})`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(range.normalise ? range.normalise(value) : value);
    }
  }
  if (values.size === 0) throw cronError(`empty ${name} field`);
  return { values: [...values].sort((a, b) => a - b), restricted };
}

function cronError(message: string): AppError {
  return new AppError(
    'kernel.WORKFLOW_INVALID',
    `invalid cron expression: ${message}`,
    undefined,
    422,
    {
      category: 'validation',
      retryable: false,
      userMessage: 'The schedule cron expression is invalid; check the boot logs.',
    },
  );
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw cronError(`expected 5 fields, got ${fields.length} in "${expression}"`);
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const minutes = parseField(minute, 0);
  const hours = parseField(hour, 1);
  const daysOfMonth = parseField(dom, 2);
  const months = parseField(month, 3);
  const daysOfWeek = parseField(dow, 4);
  return {
    expression: expression.trim(),
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: daysOfMonth.values,
    months: months.values,
    daysOfWeek: daysOfWeek.values,
    domRestricted: daysOfMonth.restricted,
    dowRestricted: daysOfWeek.restricted,
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.months.includes(date.getUTCMonth() + 1)) return false;
  const dom = spec.daysOfMonth.includes(date.getUTCDate());
  const dow = spec.daysOfWeek.includes(date.getUTCDay());
  if (spec.domRestricted && spec.dowRestricted) return dom || dow;
  if (spec.domRestricted) return dom;
  if (spec.dowRestricted) return dow;
  return true;
}

/**
 * First occurrence strictly after `after`, in UTC. Bounded to five years so a
 * valid-looking expression that can never match (e.g. `0 0 30 2 *`) fails
 * loudly instead of looping forever.
 */
export function nextCronOccurrence(expression: string | CronSpec, after: Date = new Date()): Date {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression;
  const start = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const maxDays = 366 * 5;
  for (let offset = 0; offset <= maxDays; offset += 1) {
    const day = new Date(startDay + offset * 86_400_000);
    if (!dayMatches(spec, day)) continue;
    for (const hour of spec.hours) {
      if (offset === 0 && hour < start.getUTCHours()) continue;
      for (const minute of spec.minutes) {
        if (offset === 0 && hour === start.getUTCHours() && minute < start.getUTCMinutes()) {
          continue;
        }
        const candidate = Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate(),
          hour,
          minute,
        );
        if (candidate >= start.getTime()) return new Date(candidate);
      }
    }
  }
  throw cronError(`"${spec.expression}" never fires in the next five years`);
}

/** Approximate cadence in minutes, from two consecutive occurrences. */
export function cronIntervalMinutes(
  expression: string | CronSpec,
  from: Date = new Date(),
): number {
  const first = nextCronOccurrence(expression, from);
  const second = nextCronOccurrence(expression, first);
  return Math.max(1, Math.round((second.getTime() - first.getTime()) / 60_000));
}
