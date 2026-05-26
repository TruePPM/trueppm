import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatAge, formatUpdatedAgo, formatBytes, formatTimeAgo } from './formatAge';

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

describe('formatBytes', () => {
  it('returns "—" for null (estimate unavailable)', () => {
    expect(formatBytes(null)).toBe('—');
  });

  it('formats sub-KB as bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('keeps one decimal below 10 of a unit', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('rounds to a whole number at or above 10 of a unit', () => {
    expect(formatBytes(480_000_000)).toBe('458 MB');
  });

  it('scales into GB', () => {
    expect(formatBytes(1024 ** 3 * 2)).toBe('2.0 GB');
  });
});

describe('formatTimeAgo', () => {
  const now = 1_716_600_000_000;

  it('returns "—" for null', () => {
    expect(formatTimeAgo(null, now)).toBe('—');
  });

  it('formats recent seconds', () => {
    expect(formatTimeAgo(new Date(now - 10_000).toISOString(), now)).toBe('10s ago');
  });

  it('formats minutes via formatAge', () => {
    expect(formatTimeAgo(new Date(now - 125_000).toISOString(), now)).toBe('2m ago');
  });

  it('formats hours via formatAge', () => {
    expect(formatTimeAgo(new Date(now - 7_200_000).toISOString(), now)).toBe('2h ago');
  });

  it('clamps a future timestamp to 0s', () => {
    expect(formatTimeAgo(new Date(now + 5_000).toISOString(), now)).toBe('0s ago');
  });
});
