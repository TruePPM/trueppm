import { describe, expect, it } from 'vitest';
import { formatRelative } from './formatRelative';

const NOW = new Date('2026-05-05T12:00:00Z').getTime();

describe('formatRelative', () => {
  it('returns "just now" for diffs under a minute', () => {
    expect(formatRelative(new Date(NOW - 30_000), NOW)).toBe('just now');
  });

  it('returns minutes when under an hour', () => {
    expect(formatRelative(new Date(NOW - 5 * 60_000), NOW)).toBe('5m ago');
    expect(formatRelative(new Date(NOW - 59 * 60_000), NOW)).toBe('59m ago');
  });

  it('returns hours when under a day', () => {
    expect(formatRelative(new Date(NOW - 2 * 3_600_000), NOW)).toBe('2h ago');
    expect(formatRelative(new Date(NOW - 23 * 3_600_000), NOW)).toBe('23h ago');
  });

  it('returns days when under a week', () => {
    expect(formatRelative(new Date(NOW - 3 * 86_400_000), NOW)).toBe('3d ago');
    expect(formatRelative(new Date(NOW - 6 * 86_400_000), NOW)).toBe('6d ago');
  });

  it('falls back to "MMM D" for anything older than a week', () => {
    const eightDaysAgo = new Date(NOW - 8 * 86_400_000);
    const formatted = formatRelative(eightDaysAgo, NOW);
    // The exact formatted string depends on locale, but it should be a
    // short month-day string, not a relative one.
    expect(formatted).not.toMatch(/ago|just now/);
    expect(formatted).toMatch(/[A-Z][a-z]+ \d+/);
  });

  // #1953, ADR-0410: the <7d relative values are timezone-independent, but the
  // >7d fallback re-clocks + restyles to the user's prefs when they are passed.
  it('leaves the m/h/d-ago values unchanged when prefs are passed', () => {
    const prefs = { timeZone: 'Asia/Tokyo', dateFormat: 'eu' as const };
    expect(formatRelative(new Date(NOW - 5 * 60_000), NOW, prefs)).toBe('5m ago');
    expect(formatRelative(new Date(NOW - 3 * 86_400_000), NOW, prefs)).toBe('3d ago');
  });

  it('routes the >7d fallback through the user format + timezone', () => {
    const eightDaysAgo = new Date(NOW - 8 * 86_400_000); // 2026-04-27T12:00:00Z
    expect(formatRelative(eightDaysAgo, NOW, { timeZone: 'UTC', dateFormat: 'iso' })).toBe(
      '2026-04-27',
    );
    expect(formatRelative(eightDaysAgo, NOW, { timeZone: 'UTC', dateFormat: 'eu' })).toBe(
      '27 April 2026',
    );
  });
});
