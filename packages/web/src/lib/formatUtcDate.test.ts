import { afterEach, describe, expect, it } from 'vitest';
import { fmtUtcShort, fmtUtcLong, setActiveDateFormat } from './formatUtcDate';

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

// #1953, ADR-0410: the STYLE is user-controllable (the timezone stays UTC).
describe('formatUtcDate — date-format style (#1953)', () => {
  afterEach(() => setActiveDateFormat('us')); // restore the default for other suites

  it('an explicit style restyles the same UTC day without moving it', () => {
    expect(fmtUtcShort('2026-08-19', 'us')).toBe('Aug 19');
    expect(fmtUtcShort('2026-08-19', 'eu')).toBe('19 Aug');
    expect(fmtUtcShort('2026-08-19', 'iso')).toBe('2026-08-19');
    expect(fmtUtcLong('2026-08-19', 'us')).toBe('August 19, 2026');
    expect(fmtUtcLong('2026-08-19', 'eu')).toBe('19 August 2026');
    expect(fmtUtcLong('2026-08-19', 'iso')).toBe('2026-08-19');
  });

  it('setActiveDateFormat changes the default used by bare calls', () => {
    setActiveDateFormat('eu');
    expect(fmtUtcShort('2026-08-19')).toBe('19 Aug');
    expect(fmtUtcLong('2026-08-19')).toBe('19 August 2026');
    setActiveDateFormat('iso');
    expect(fmtUtcShort('2026-08-19')).toBe('2026-08-19');
  });

  it('the default (us) is byte-identical to the pre-#1953 output', () => {
    setActiveDateFormat('us');
    expect(fmtUtcShort('2026-08-19')).toBe('Aug 19');
    expect(fmtUtcLong('2026-08-19')).toBe('August 19, 2026');
  });
});
