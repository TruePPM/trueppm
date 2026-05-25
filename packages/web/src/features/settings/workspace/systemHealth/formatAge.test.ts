import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatAge, formatUpdatedAgo } from './formatAge';

describe('formatAge', () => {
  it('formats 0 seconds as "0s"', () => {
    expect(formatAge(0)).toBe('0s');
  });

  it('formats sub-minute seconds', () => {
    expect(formatAge(45)).toBe('45s');
    expect(formatAge(59)).toBe('59s');
  });

  it('formats exactly 60 seconds as "1m"', () => {
    expect(formatAge(60)).toBe('1m');
  });

  it('formats minutes without seconds once >= 60s', () => {
    expect(formatAge(90)).toBe('1m');
    expect(formatAge(120)).toBe('2m');
  });

  it('formats hours+minutes', () => {
    expect(formatAge(3600)).toBe('1h');
    expect(formatAge(3660)).toBe('1h1m');
    expect(formatAge(7320)).toBe('2h2m');
    expect(formatAge(8400)).toBe('2h20m');
  });

  it('suppresses minutes when they are zero in the hours range', () => {
    expect(formatAge(7200)).toBe('2h');
  });

  it('formats days+hours', () => {
    expect(formatAge(86400)).toBe('1d');
    expect(formatAge(90000)).toBe('1d1h');
    expect(formatAge(172800)).toBe('2d');
  });

  it('suppresses hours when they are zero in the days range', () => {
    expect(formatAge(86400 * 3)).toBe('3d');
  });

  it('handles fractional seconds by flooring', () => {
    expect(formatAge(45.9)).toBe('45s');
  });
});

describe('formatUpdatedAgo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "—" when dataUpdatedAt is 0 (never fetched)', () => {
    expect(formatUpdatedAgo(0)).toBe('—');
  });

  it('returns "just now" for < 5 seconds ago', () => {
    const now = 1_716_600_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now + 3000);
    expect(formatUpdatedAgo(now)).toBe('just now');
  });

  it('returns Ns ago for 5–59 seconds', () => {
    const now = 1_716_600_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
    expect(formatUpdatedAgo(now)).toBe('10s ago');
  });

  it('returns Nm ago for 60–3599 seconds', () => {
    const now = 1_716_600_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now + 125_000);
    expect(formatUpdatedAgo(now)).toBe('2m ago');
  });

  it('returns Nh ago for >= 3600 seconds', () => {
    const now = 1_716_600_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now + 7_200_000);
    expect(formatUpdatedAgo(now)).toBe('2h ago');
  });
});
