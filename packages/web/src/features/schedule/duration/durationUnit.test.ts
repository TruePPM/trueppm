import { describe, expect, it } from 'vitest';
import {
  describeEntry,
  formatDuration,
  fromStoredDays,
  toStoredDays,
  spellDuration,
  DEFAULT_HOURS_PER_DAY,
} from './durationUnit';

describe('toStoredDays — days', () => {
  it('passes a whole number through unrounded', () => {
    expect(toStoredDays(3, 'days', 8)).toEqual({ days: 3, rounded: false, exactDays: 3 });
  });

  it('rounds a fractional day and says it did', () => {
    expect(toStoredDays(2.5, 'days', 8)).toMatchObject({ days: 3, rounded: true });
  });

  it('never stores a negative duration', () => {
    expect(toStoredDays(-4, 'days', 8).days).toBe(0);
  });
});

describe('toStoredDays — hours', () => {
  it('converts an exact multiple with no rounding', () => {
    expect(toStoredDays(16, 'hours', 8)).toEqual({ days: 2, rounded: false, exactDays: 2 });
  });

  it('rounds UP, because under-planning a schedule is the expensive error', () => {
    // 20h on an 8h day is 2.5 days. Two days does not fit the work.
    expect(toStoredDays(20, 'hours', 8)).toMatchObject({ days: 3, rounded: true, exactDays: 2.5 });
  });

  it('rounds a single hour up to a day rather than to zero', () => {
    // Rounding to nearest would store 0 and the task would take no time at all,
    // which on a CPM schedule silently removes it from the critical path.
    expect(toStoredDays(1, 'hours', 8)).toMatchObject({ days: 1, rounded: true });
  });

  it('honors a fractional hours_per_day', () => {
    expect(toStoredDays(15, 'hours', 7.5)).toEqual({ days: 2, rounded: false, exactDays: 2 });
  });

  it('falls back to 8 when the calendar has not loaded', () => {
    expect(toStoredDays(8, 'hours', null).days).toBe(1);
    expect(DEFAULT_HOURS_PER_DAY).toBe(8);
  });

  it('does not divide by a zero or negative hours_per_day', () => {
    // The calendar validator should prevent this; a NaN or Infinity duration
    // reaching the engine would be far worse than a fallback.
    expect(Number.isFinite(toStoredDays(8, 'hours', 0).days)).toBe(true);
    expect(toStoredDays(8, 'hours', 0).days).toBe(1);
    expect(Number.isFinite(toStoredDays(8, 'hours', -3).days)).toBe(true);
  });
});

describe('fromStoredDays', () => {
  it('round-trips days', () => {
    expect(fromStoredDays(3, 'days', 8)).toBe(3);
  });

  it('expands days into hours', () => {
    expect(fromStoredDays(3, 'hours', 8)).toBe(24);
  });

  it('shows the round-trip rather than hiding it', () => {
    // 20h was stored as 3 d, so reading it back in hours says 24 — the user can
    // see what the schedule actually reserved.
    const stored = toStoredDays(20, 'hours', 8);
    expect(fromStoredDays(stored.days, 'hours', 8)).toBe(24);
  });
});

describe('formatDuration', () => {
  it('labels each unit', () => {
    expect(formatDuration(3, 'days', 8)).toBe('3d');
    expect(formatDuration(3, 'hours', 8)).toBe('24h');
  });

  it('trims a fractional hour to one decimal', () => {
    expect(formatDuration(1, 'hours', 7.5)).toBe('7.5h');
  });

  it('does not print a trailing .0', () => {
    expect(formatDuration(2, 'hours', 7.5)).toBe('15h');
  });
});

describe('describeEntry — the rounding must never be silent', () => {
  it('says nothing when nothing was rounded', () => {
    expect(describeEntry(toStoredDays(16, 'hours', 8), 'hours')).toBeNull();
  });

  it('states what was stored AND why', () => {
    const msg = describeEntry(toStoredDays(20, 'hours', 8), 'hours');
    expect(msg).toContain('2.5 days');
    expect(msg).toContain('stored as 3 days');
    expect(msg).toContain('whole days');
  });

  it('singularizes one day', () => {
    expect(describeEntry(toStoredDays(1, 'hours', 8), 'hours')).toContain('stored as 1 day');
  });

  it('explains a rounded day entry too', () => {
    expect(describeEntry(toStoredDays(2.5, 'days', 8), 'days')).toContain('whole working days');
  });

  it('keeps both decimals when neither is a trailing zero', () => {
    // Guards the trailing-zero trim: it must strip only a zero in the final
    // place, never a significant digit. 18h @ 8h/day is exactly 2.25 days.
    expect(describeEntry(toStoredDays(18, 'hours', 8), 'hours')).toContain('2.25 days');
  });

  it('strips a single trailing zero but leaves the point intact', () => {
    expect(describeEntry(toStoredDays(20, 'hours', 8), 'hours')).toContain('2.5 days');
  });
});

describe('spellDuration — the accessible name must not be the abbreviation', () => {
  it('spells the unit out', () => {
    // "12d" is read aloud as "twelve dee".
    expect(spellDuration(12, 'days', 8)).toBe('12 days');
    expect(spellDuration(3, 'hours', 8)).toBe('24 hours');
  });

  it('singularizes one', () => {
    expect(spellDuration(1, 'days', 8)).toBe('1 day');
  });
});
