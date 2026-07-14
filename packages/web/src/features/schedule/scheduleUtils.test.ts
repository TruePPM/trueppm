import { describe, it, expect } from 'vitest';
import { formatShortDate, nudgeWorkingDays } from './scheduleUtils';

// ---------------------------------------------------------------------------
// formatShortDate
// ---------------------------------------------------------------------------

// formatShortDate wraps a UTC-pinned Intl.DateTimeFormat; the reference formatter
// must also pin timeZone:'UTC' so the contract test holds in any runner zone.
const fmt = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(iso),
  );

describe('formatShortDate', () => {
  it('matches UTC-pinned Intl.DateTimeFormat en-US short month + numeric day', () => {
    expect(formatShortDate('2025-04-07')).toBe(fmt('2025-04-07'));
  });

  it('contains the month abbreviation for the given month', () => {
    expect(formatShortDate('2025-12-25')).toContain('Dec');
  });

  it('does not include a four-digit year', () => {
    expect(formatShortDate('2025-01-05')).not.toMatch(/\d{4}/);
  });

  // Regression guard for #1927: a date-only ISO parses to UTC midnight. Without
  // timeZone:'UTC' the formatter renders in the browser's local zone and shows
  // the *previous* calendar day for every viewer west of UTC. Pinning the
  // expected output to the UTC calendar day fails if the UTC pinning regresses
  // (on any machine whose local zone is west of UTC — CI and most dev machines).
  it('renders the UTC calendar day, not the local day west of UTC', () => {
    expect(formatShortDate('2025-04-07')).toBe('Apr 7');
    expect(formatShortDate('2026-01-01')).toBe('Jan 1');
  });
});

describe('nudgeWorkingDays', () => {
  // 2025-03-17 is a Monday
  const MONDAY = '2025-03-17';
  // 2025-03-21 is a Friday
  const FRIDAY = '2025-03-21';
  // 2025-03-22 is a Saturday
  const SATURDAY = '2025-03-22';

  it('returns the same date for 0 days', () => {
    expect(nudgeWorkingDays(MONDAY, 0)).toBe(MONDAY);
  });

  it('advances by 1 working day (Mon → Tue)', () => {
    expect(nudgeWorkingDays(MONDAY, 1)).toBe('2025-03-18');
  });

  it('advances by 5 working days (Mon → next Mon)', () => {
    expect(nudgeWorkingDays(MONDAY, 5)).toBe('2025-03-24');
  });

  it('retreats by 1 working day (Mon → Fri)', () => {
    expect(nudgeWorkingDays(MONDAY, -1)).toBe('2025-03-14');
  });

  it('retreats by 5 working days (Mon → Mon)', () => {
    expect(nudgeWorkingDays(MONDAY, -5)).toBe('2025-03-10');
  });

  it('skips Saturday when advancing from Friday', () => {
    // Fri + 1 working day = Monday
    expect(nudgeWorkingDays(FRIDAY, 1)).toBe('2025-03-24');
  });

  it('skips Saturday and Sunday when retreating from Monday', () => {
    // Mon - 1 working day = Friday
    expect(nudgeWorkingDays(MONDAY, -1)).toBe('2025-03-14');
  });

  it('accepts a date that starts on Saturday (advances to next Monday)', () => {
    // Saturday + 1 working day = Monday
    expect(nudgeWorkingDays(SATURDAY, 1)).toBe('2025-03-24');
  });

  it('handles large nudge (10 working days = 2 calendar weeks)', () => {
    // Mon + 10 working days = Monday 2 weeks later
    expect(nudgeWorkingDays(MONDAY, 10)).toBe('2025-03-31');
  });

  it('returns a YYYY-MM-DD string regardless of input length', () => {
    const result = nudgeWorkingDays('2025-03-17', 3);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
