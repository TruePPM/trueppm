import { describe, expect, it } from 'vitest';
import {
  WEEKDAYS,
  bitForDate,
  computeNextOccurrences,
  formatOccurrence,
  parseIsoDate,
  pyWeekday,
  toggleWeekday,
  type RecurrenceRuleInput,
} from './recurrence';

/** A WEEKLY-Monday rule baseline; override per test. */
function rule(overrides: Partial<RecurrenceRuleInput> = {}): RecurrenceRuleInput {
  return {
    task: 't1',
    frequency: 'WEEKLY',
    interval: 1,
    weekdays: 1, // Monday
    day_of_month: null,
    time_of_day: '09:00',
    timezone: 'UTC',
    end_type: 'NEVER',
    end_date: null,
    end_count: null,
    inherit_assignee: true,
    inherit_subtasks: false,
    inherit_attachments: false,
    inherit_morning_notification: false,
    ...overrides,
  };
}

const isoDates = (items: { date: Date }[]) =>
  items.map((i) =>
    `${i.date.getFullYear()}-${String(i.date.getMonth() + 1).padStart(2, '0')}-${String(
      i.date.getDate(),
    ).padStart(2, '0')}`,
  );

describe('weekday bitmask helpers', () => {
  it('maps JS getDay() to the server Mon=0..Sun=6 convention', () => {
    // 2026-05-11 is a Monday → pyWeekday 0, bit 1.
    expect(pyWeekday(new Date(2026, 4, 11))).toBe(0);
    expect(bitForDate(new Date(2026, 4, 11))).toBe(1);
    // 2026-05-17 is a Sunday → pyWeekday 6, bit 64.
    expect(pyWeekday(new Date(2026, 4, 17))).toBe(6);
    expect(bitForDate(new Date(2026, 4, 17))).toBe(64);
  });

  it('WEEKDAYS table is Mon=1 … Sun=64 in display order', () => {
    expect(WEEKDAYS.map((w) => w.bit)).toEqual([1, 2, 4, 8, 16, 32, 64]);
  });

  it('toggleWeekday flips the bit both ways', () => {
    expect(toggleWeekday(0, 4)).toBe(4);
    expect(toggleWeekday(5, 4)).toBe(1);
    expect(toggleWeekday(5, 2)).toBe(7);
  });
});

describe('computeNextOccurrences', () => {
  it('DAILY interval 1 returns consecutive days from `from`', () => {
    const from = new Date(2026, 4, 11); // Mon
    const items = computeNextOccurrences(rule({ frequency: 'DAILY', interval: 1 }), 4, from);
    expect(isoDates(items)).toEqual(['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14']);
  });

  it('CUSTOM is "every N days" anchored on `from`', () => {
    const from = new Date(2026, 4, 11);
    const items = computeNextOccurrences(rule({ frequency: 'CUSTOM', interval: 3 }), 3, from);
    expect(isoDates(items)).toEqual(['2026-05-11', '2026-05-14', '2026-05-17']);
  });

  it('WEEKLY on Monday returns the next four Mondays', () => {
    const from = new Date(2026, 4, 11); // Mon May 11
    const items = computeNextOccurrences(rule({ frequency: 'WEEKLY', weekdays: 1 }), 4, from);
    expect(isoDates(items)).toEqual(['2026-05-11', '2026-05-18', '2026-05-25', '2026-06-01']);
  });

  it('WEEKLY on multiple weekdays returns each matching day', () => {
    const from = new Date(2026, 4, 11); // Mon
    // Mon (1) + Wed (4) + Fri (16) = 21.
    const items = computeNextOccurrences(rule({ frequency: 'WEEKLY', weekdays: 21 }), 4, from);
    expect(isoDates(items)).toEqual(['2026-05-11', '2026-05-13', '2026-05-15', '2026-05-18']);
  });

  it('WEEKLY interval 2 aligns to the anchor week (skips the in-between week)', () => {
    const from = new Date(2026, 4, 11); // Mon May 11
    const items = computeNextOccurrences(
      rule({ frequency: 'WEEKLY', weekdays: 1, interval: 2 }),
      3,
      from,
    );
    expect(isoDates(items)).toEqual(['2026-05-11', '2026-05-25', '2026-06-08']);
  });

  it('MONTHLY clamps day_of_month to the month length (31 → Feb 28)', () => {
    const from = new Date(2027, 0, 31); // Jan 31, 2027
    const items = computeNextOccurrences(
      rule({ frequency: 'MONTHLY', day_of_month: 31, weekdays: 0 }),
      3,
      from,
    );
    // Jan 31, Feb 28 (clamped — 2027 is not a leap year), Mar 31.
    expect(isoDates(items)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });

  it('ON_DATE truncates the series at the end date', () => {
    const from = new Date(2026, 4, 11);
    const items = computeNextOccurrences(
      rule({ frequency: 'WEEKLY', weekdays: 1, end_type: 'ON_DATE', end_date: '2026-05-25' }),
      10,
      from,
    );
    expect(isoDates(items)).toEqual(['2026-05-11', '2026-05-18', '2026-05-25']);
  });

  it('AFTER_N caps by remaining occurrences (end_count minus already-generated)', () => {
    const from = new Date(2026, 4, 11);
    const items = computeNextOccurrences(
      { ...rule({ frequency: 'DAILY', interval: 1, end_type: 'AFTER_N', end_count: 5 }), occurrence_count: 3 },
      10,
      from,
    );
    expect(items).toHaveLength(2); // 5 total − 3 already = 2 remaining
  });

  it('returns [] for a weekly rule with no weekday selected (never fires)', () => {
    const from = new Date(2026, 4, 11);
    expect(computeNextOccurrences(rule({ frequency: 'WEEKLY', weekdays: 0 }), 4, from)).toEqual([]);
  });

  it('carries the trimmed time onto every item', () => {
    const from = new Date(2026, 4, 11);
    const items = computeNextOccurrences(rule({ frequency: 'DAILY', time_of_day: '14:30:00' }), 2, from);
    expect(items.every((i) => i.time === '14:30')).toBe(true);
  });
});

describe('formatOccurrence + parseIsoDate', () => {
  it('parses an ISO date to local midnight without a timezone shift', () => {
    const d = parseIsoDate('2026-05-11');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 4, 11]);
  });

  it('formats as "Wkdy Mon D, HH:MM"', () => {
    expect(formatOccurrence({ date: new Date(2026, 4, 11), time: '09:00' })).toBe('Mon, May 11, 09:00');
  });
});
