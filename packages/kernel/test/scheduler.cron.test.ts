import { describe, expect, it } from 'vitest';

import {
  cronIntervalMinutes,
  isValidCron,
  nextCronOccurrence,
  parseCron,
} from '../src/scheduler/cron.js';

const at = (iso: string): Date => new Date(iso);

describe('five-field cron parser (18.T4)', () => {
  it('parses wildcards, steps, ranges and lists', () => {
    const spec = parseCron('*/15 9-17 1,15 * 1-5');
    expect(spec.minutes).toEqual([0, 15, 30, 45]);
    expect(spec.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(spec.daysOfMonth).toEqual([1, 15]);
    expect(spec.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(spec.domRestricted).toBe(true);
    expect(spec.dowRestricted).toBe(true);
  });

  it('normalises Sunday 7 to 0', () => {
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0]);
  });

  it('rejects malformed expressions with a validation error', () => {
    for (const expression of [
      '',
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      '*/0 * * * *',
      '5-1 * * * *',
      'a * * * *',
    ]) {
      expect(isValidCron(expression), expression).toBe(false);
    }
    expect(() => parseCron('* * * *')).toThrow(/expected 5 fields/);
  });

  it('computes the next weekday occurrence in UTC', () => {
    // Friday 13 Nov 2026 08:00Z → Friday 09:00Z; after Friday 09:00 → Monday.
    expect(nextCronOccurrence('0 9 * * 1-5', at('2026-11-13T08:00:00Z')).toISOString()).toBe(
      '2026-11-13T09:00:00.000Z',
    );
    expect(nextCronOccurrence('0 9 * * 1-5', at('2026-11-13T09:00:00Z')).toISOString()).toBe(
      '2026-11-16T09:00:00.000Z',
    );
  });

  it('is strictly after the supplied minute', () => {
    expect(nextCronOccurrence('* * * * *', at('2026-11-11T10:00:00Z')).toISOString()).toBe(
      '2026-11-11T10:01:00.000Z',
    );
    expect(nextCronOccurrence('*/15 * * * *', at('2026-11-11T10:07:30Z')).toISOString()).toBe(
      '2026-11-11T10:15:00.000Z',
    );
  });

  it('uses OR when both day-of-month and day-of-week are restricted', () => {
    // 13 Nov 2026 is a Friday. From the 1st, the next match is Friday the 6th.
    expect(nextCronOccurrence('0 0 13 * 5', at('2026-11-01T00:00:00Z')).toISOString()).toBe(
      '2026-11-06T00:00:00.000Z',
    );
    // From the 7th the next match is Friday the 13th (both rules agree).
    expect(nextCronOccurrence('0 0 13 * 5', at('2026-11-07T00:00:00Z')).toISOString()).toBe(
      '2026-11-13T00:00:00.000Z',
    );
  });

  it('handles month boundaries and leap day', () => {
    expect(nextCronOccurrence('0 0 1 * *', at('2026-11-11T10:00:00Z')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z',
    );
    expect(nextCronOccurrence('0 0 29 2 *', at('2026-11-11T10:00:00Z')).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('reports cadence in minutes', () => {
    expect(cronIntervalMinutes('*/15 * * * *', at('2026-11-11T10:07:30Z'))).toBe(15);
    expect(cronIntervalMinutes('0 * * * *', at('2026-11-11T10:07:30Z'))).toBe(60);
  });
});
