import { describe, expect, it } from 'vitest';
import { fmtUtcShort, fmtUtcLong } from './formatUtcDate';

describe('formatUtcDate', () => {
  // `new Date('2026-08-19')` is UTC midnight. A local-zone formatter renders
  // this as Aug 18 for any viewer west of UTC (negative offset). Pinning UTC
  // must keep it on Aug 19 regardless of the host timezone — this is the exact
  // date-disagreement bug ADR-0144 fixes.
  it('fmtUtcShort renders the UTC calendar day, never the local-zone one', () => {
    expect(fmtUtcShort('2026-08-19')).toBe('Aug 19');
  });

  it('fmtUtcLong renders the UTC calendar day, never the local-zone one', () => {
    expect(fmtUtcLong('2026-08-19')).toBe('August 19, 2026');
  });

  it('handles a full ISO timestamp at UTC midnight without drifting a day', () => {
    expect(fmtUtcShort('2026-01-01T00:00:00Z')).toBe('Jan 1');
    expect(fmtUtcLong('2026-01-01T00:00:00Z')).toBe('January 1, 2026');
  });

  it('returns an em-dash for empty / null / undefined input', () => {
    expect(fmtUtcShort('')).toBe('—');
    expect(fmtUtcShort(null)).toBe('—');
    expect(fmtUtcShort(undefined)).toBe('—');
    expect(fmtUtcLong('')).toBe('—');
    expect(fmtUtcLong(null)).toBe('—');
    expect(fmtUtcLong(undefined)).toBe('—');
  });

  it('returns the raw string when the input is non-empty but unparseable', () => {
    expect(fmtUtcShort('not-a-date')).toBe('not-a-date');
    expect(fmtUtcLong('not-a-date')).toBe('not-a-date');
  });
});
