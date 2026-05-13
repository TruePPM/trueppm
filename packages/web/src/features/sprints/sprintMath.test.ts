import { describe, it, expect, vi, afterEach } from 'vitest';
import { daysBetween, sprintDayOf, daysUntil, formatShortDate, formatDateRange } from './sprintMath';

afterEach(() => {
  vi.useRealTimers();
});

describe('daysBetween', () => {
  it('counts inclusive day diffs across month boundary', () => {
    expect(daysBetween('2026-04-29', '2026-05-02')).toBe(3);
  });

  it('returns 0 for the same day', () => {
    expect(daysBetween('2026-04-10', '2026-04-10')).toBe(0);
  });

  it('returns negative for end before start', () => {
    expect(daysBetween('2026-04-10', '2026-04-08')).toBe(-2);
  });
});

describe('sprintDayOf', () => {
  it('returns day-N-of-M for a date inside the window', () => {
    const today = new Date('2026-04-04T12:00:00Z');
    expect(sprintDayOf('2026-04-01', '2026-04-14', today)).toEqual({ day: 4, total: 14 });
  });

  it('clamps to 1 when today is before sprint start', () => {
    const today = new Date('2026-03-01T12:00:00Z');
    expect(sprintDayOf('2026-04-01', '2026-04-14', today)).toEqual({ day: 1, total: 14 });
  });

  it('clamps to total when today is past sprint finish', () => {
    const today = new Date('2026-05-01T12:00:00Z');
    expect(sprintDayOf('2026-04-01', '2026-04-14', today)).toEqual({ day: 14, total: 14 });
  });
});

describe('daysUntil', () => {
  it('returns positive count for a future date', () => {
    const today = new Date('2026-04-01T12:00:00Z');
    expect(daysUntil('2026-04-08', today)).toBe(7);
  });

  it('returns negative count when the target is past', () => {
    const today = new Date('2026-04-08T12:00:00Z');
    expect(daysUntil('2026-04-01', today)).toBe(-7);
  });
});

describe('sprintDayOf / daysUntil — local-zone date used, not UTC (#401)', () => {
  it('sprintDayOf uses local date from the Date object, not UTC date', () => {
    // Apr 4 21:00 local (getDate()=4) but Apr 5 04:00 UTC (toISOString()="2026-04-05T...").
    // Construct a Date such that getDate()=4 and getUTCDate()=5 to verify
    // the implementation reads local date, not UTC date.
    // We simulate this by supplying a known Date and checking the result is
    // consistent with getDate() rather than toISOString().
    const today = new Date(2026, 3, 4, 21, 0, 0); // Apr 4 21:00 LOCAL
    const result = sprintDayOf('2026-04-01', '2026-04-14', today);
    // Local date is Apr 4 → elapsed = daysBetween('2026-04-01', '2026-04-04') + 1 = 4
    // UTC date would be Apr 5 → elapsed = 5
    expect(result.day).toBe(4);
    expect(result.total).toBe(14);
  });

  it('daysUntil uses local date from the Date object, not UTC date', () => {
    const today = new Date(2026, 3, 4, 21, 0, 0); // Apr 4 21:00 LOCAL
    // Days until Apr 8 from Apr 4 local = 4
    expect(daysUntil('2026-04-08', today)).toBe(4);
  });
});

describe('formatShortDate / formatDateRange', () => {
  it('formats a single date as Mon D', () => {
    expect(formatShortDate('2026-04-07')).toBe('Apr 7');
  });

  it('formats a range with em-dashes', () => {
    expect(formatDateRange('2026-04-07', '2026-04-21')).toBe('Apr 7 – Apr 21');
  });
});
