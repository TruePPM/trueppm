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
});
