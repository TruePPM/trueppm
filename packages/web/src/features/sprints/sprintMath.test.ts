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

describe('formatShortDate / formatDateRange', () => {
  it('formats a single date as Mon D', () => {
    expect(formatShortDate('2026-04-07')).toBe('Apr 7');
  });

  it('formats a range with em-dashes', () => {
    expect(formatDateRange('2026-04-07', '2026-04-21')).toBe('Apr 7 – Apr 21');
  });
});
